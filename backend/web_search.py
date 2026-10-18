"""Web search, tried in order of how much we trust the answer.

1. OpenAI's hosted web_search tool (WEB_SEARCH_PROVIDER=openai). Uses the
   OpenAI key the request already runs on — no second vendor and no scraping —
   so a request on xAI or Groq skips this tier. Returns url_citation annotations, i.e. real source URLs rather than a
   search-engine snippet. Billed per call on top of the tokens the results add to
   context, so it is a real cost, not a free tier.

2. Tavily (WEB_SEARCH_PROVIDER=tavily). A real search API with a free tier;
   returns structured JSON, so a failure is an error rather than wrong data.

3. HTML scraping via `ddgs` — LAST RESORT, and off by default in `auto` unless
   nothing else is configured.

   This tier must be understood before it is trusted. It parses a search engine's
   HTML, so when the engine blocks or rate-limits it, the response is still
   HTTP 200 and the parser happily extracts whatever generic page came back.
   Observed on this project: "Elon Musk recent project 2026" returned iLovePDF
   and Google Play listings; "Elon Musk total revenue 2026" returned COSRX snail
   mucin skincare. Not an error, not empty — eight confident, entirely unrelated
   results, which then appear in the UI as citations.

   Driving a real browser instead does not fix this. It is the same failure with
   more moving parts: seconds per query, a browser in the deployment, and a
   CAPTCHA after a handful of requests. Scraping cannot be made reliable here;
   it can only be contained. Hence `_relevance`, below, which every scraped
   result must pass before it is allowed to become a citation.

Everything is cached by query for 5 minutes.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import quote

import httpx

from . import config

log = logging.getLogger("universalcb.search")

_CACHE_TTL = 300  # 5 minutes
_CACHE_MAX = 500
# Ceiling for one search() call across every tier it falls through.
_SEARCH_BUDGET_S = 14.0
_GROQ_SEARCH_TIMEOUT_S = 8.0
# After Groq answers a hosted search with 429, skip that tier for this long. A
# search that cannot run must not also spend the minute's remaining budget the
# answer call needs. Module-wide rather than per key: nothing derived from a
# credential is kept in memory, at the price of one user's limit pausing the
# tier for everyone — acceptable for an opt-in tier meant for paid keys.
_GROQ_429_PAUSE_S = 120.0
_groq_search_paused_until = 0.0
# Scrape tier: the whole attempt, and each engine request inside it. `auto`
# was measured at ~4.5s, so the outer limit leaves it room to finish.
_SCRAPE_TIMEOUT_S = 6.0
_SCRAPE_ENGINE_TIMEOUT_S = 3
# Abandoned scrape threads run to completion; kept off asyncio's default pool
# (5 workers on a 1-vCPU Cloud Run instance) so they can't starve other work.
_SCRAPE_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="scrape")
_WIKI_TIMEOUT_S = 4.0
_WIKI_MAX_SUMMARIES = 5
_cache: dict[str, tuple[float, list[dict]]] = {}

# Wikimedia rejects generic agents outright: both a bare "AppName/0.1 (educational)"
# and "Mozilla/5.0" get a 403 pointing at https://w.wiki/4wJS, which silently
# disabled this whole fallback tier. Their policy wants a descriptive name plus a
# way to reach the operator — set HTTP_CONTACT to a real address you own.
_CONTACT = os.getenv("HTTP_CONTACT", "https://github.com/sakshamkanojia19/nexus").strip()
USER_AGENT = os.getenv("HTTP_USER_AGENT", f"Nexus/0.3 (+{_CONTACT}) python-httpx").strip()

# Snippets run ~240 chars each, so four of them is a very thin basis for an
# answer. The upstream cost is the same request either way.
DEFAULT_MAX_RESULTS = int(os.getenv("WEB_SEARCH_MAX_RESULTS", "8"))


# ── Relevance guard ──────────────────────────────────────────────────────────
# Words carrying no topical signal. A result matching only these has matched
# nothing — "the latest news about X" should not be satisfied by "the news".
_STOPWORDS = frozenset("""
a an and are as at be by for from has have how in is it its of on or that the
to was what when where which who why with about latest recent news update
please tell me give show find search info information can you your
""".split())


def _terms(text: str) -> set[str]:
    """Meaningful lowercase words, punctuation and stopwords removed."""
    words = re.findall(r"[^\W\d_]+", (text or "").lower(), flags=re.UNICODE)
    return {w for w in words if len(w) > 2 and w not in _STOPWORDS}


def _relevance(query: str, result: dict[str, Any]) -> float:
    """Share of the query's meaningful terms that appear in the result.

    Deliberately crude — it is not ranking results, it is catching the case
    where the scraper returned a page about something else entirely. A real
    result for "Elon Musk revenue" contains at least one of those words; a
    snail mucin listing contains none.
    """
    wanted = _terms(query)
    if not wanted:
        return 1.0  # nothing to check against — don't reject on no evidence
    haystack = _terms(f"{result.get('title', '')} {result.get('snippet', '')} {result.get('url', '')}")
    if not haystack:
        return 0.0
    return len(wanted & haystack) / len(wanted)


def _filter_relevant(query: str, results: list[dict[str, Any]], source: str) -> list[dict[str, Any]]:
    """Drop results that share too little with the query, and say so loudly.

    A silently-wrong search is the worst outcome here: the model gets misleading
    context and the user gets citations to pages that were never about their
    question. Better to return nothing and let the agent say it found nothing.
    """
    threshold = config.WEB_SEARCH_MIN_RELEVANCE
    if threshold <= 0:
        return results
    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    for r in results:
        if _relevance(query, r) >= threshold:
            kept.append(r)
        else:
            dropped.append((r.get("title") or r.get("url") or "?")[:60])
    if dropped:
        log.warning(
            "%s: dropped %d/%d off-topic result(s) for %r (e.g. %r) — "
            "the search tier is probably blocked or rate-limited",
            source, len(dropped), len(results), query, dropped[:3],
        )
    return kept


# ── Entry point ──────────────────────────────────────────────────────────────
async def search(
    query: str,
    max_results: int = DEFAULT_MAX_RESULTS,
    api_key: str | None = None,
    hosted: str | None = None,
) -> list[dict[str, Any]]:
    """Return top results as a list of {title, snippet, url}.

    `api_key` is the caller's own key, and `hosted` names the vendor it belongs
    to ("openai" or "groq"); together they decide which hosted search tier may
    run, paid for by that key. None skips the hosted tiers. There is
    deliberately no fallback to the server's key here: a request on another
    provider passes None, and must not end up spending the operator's credit.
    Results are cached by query and tier — the cache holds public search
    results, never anything derived from the credential.
    """
    if api_key and hosted is None:
        hosted = "openai"  # the original contract: a bare key was an OpenAI key
    tier = hosted if api_key else "keyless"
    key = f"{config.WEB_SEARCH_PROVIDER}:{tier}:{query.strip().lower()}"
    now = time.time()

    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        log.info("cache hit: %r -> %d results", query, len(hit[1]))
        return hit[1]

    provider = config.WEB_SEARCH_PROVIDER
    log.info("search: %r (provider=%s, tier=%s)", query, provider, tier)
    started = time.monotonic()
    try:
        # One ceiling for the whole ladder. Each tier has its own limit too, but
        # three tiers failing slowly in a row is a voice turn of dead air.
        results = await asyncio.wait_for(
            _dispatch(provider, query, max_results, api_key, hosted), timeout=_SEARCH_BUDGET_S,
        )
    except asyncio.TimeoutError:
        log.warning("search budget (%.0fs) spent: %r", _SEARCH_BUDGET_S, query)
        results = []

    log.info("search done: %r -> %d results in %.1fs", query, len(results), time.monotonic() - started)
    if results:
        if len(_cache) >= _CACHE_MAX:
            _cache.pop(next(iter(_cache)))  # oldest insert first
        _cache[key] = (now, results)
    return results


def _key_belongs_to(api_key: str | None, vendor: str) -> bool:
    """Whether `api_key` is shaped like `vendor`'s. A key is only ever sent to
    the vendor that issued it, whatever the caller claims."""
    from . import providers

    p = providers.PROVIDERS.get(vendor)
    return bool(api_key and p and p.key_re.match(api_key))


async def _dispatch(
    provider: str, query: str, max_results: int, api_key: str | None = None,
    hosted: str | None = "openai",
) -> list[dict[str, Any]]:
    """Run the configured provider, or walk the ladder when set to `auto`."""
    openai_key = api_key if hosted == "openai" and _key_belongs_to(api_key, "openai") else None
    groq_key = api_key if hosted == "groq" and _key_belongs_to(api_key, "groq") else None
    if provider == "openai":
        return await _openai_search(query, max_results, openai_key)
    if provider == "groq":
        return await _groq_search(query, max_results, groq_key)
    if provider == "tavily":
        return await _tavily_search(query, max_results)
    if provider == "scrape":
        return await _scrape_search(query, max_results)

    # auto: best available first. Each tier is skipped when unconfigured, so a
    # deployment with only an OpenAI key gets hosted search, and one with no keys
    # at all still gets something rather than nothing.
    if openai_key:
        results = await _openai_search(query, max_results, openai_key)
        if results:
            return results
        log.info("hosted search returned 0 — falling through")
    if groq_key and config.GROQ_BROWSER_SEARCH:
        results = await _groq_search(query, max_results, groq_key)
        if results:
            return results
        log.info("Groq browser search returned 0 — falling through")
    if config.TAVILY_API_KEY:
        results = await _tavily_search(query, max_results)
        if results:
            return results
        log.info("Tavily returned 0 — falling through")
    results = await _scrape_search(query, max_results)
    if results:
        return results
    log.info("scrape returned 0 — trying Wikipedia")
    return await _wikipedia_search(query, max_results)


# ── 1. OpenAI hosted web search ──────────────────────────────────────────────
async def _openai_search(
    query: str, max_results: int, api_key: str | None = None,
) -> list[dict[str, Any]]:
    """Ask OpenAI's hosted web_search tool and read back its url_citations.

    The annotations are the point: they are the URLs the tool actually consulted,
    so citations reflect real pages rather than a scraper's guess at one.
    """
    key = api_key
    if not key:
        return []
    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=key)
        today = time.strftime("%d %B %Y")
        response = await client.responses.create(
            model=config.WEB_SEARCH_MODEL,
            tools=[{"type": "web_search"}],
            tool_choice="required",
            # Dense factual notes, not prose summaries: the agent downstream
            # reasons from these snippets, and "the Realme P4 is getting some
            # attention online" gives it nothing, while "₹24,999 (256GB) on
            # Flipkart, listed August 2026" answers the question outright.
            input=(
                f"Today is {today}. Search the web for this query and report what each "
                "source says as dense factual notes: concrete numbers, prices with "
                "currency, spec figures, dates, availability. Prefer the most recent "
                "sources and state each source's publish date when visible — for "
                "prices and availability, an old figure labeled with its date is "
                "useful, an undated one is misleading. "
                f"Query: {query}"
            ),
        )
        return _citations_from_response(response, max_results)
    except Exception as e:  # noqa: BLE001
        # Older SDKs lack `responses`, some accounts lack the tool, and the call
        # can simply fail. None of that should take the whole search down.
        # Scrubbed: an auth failure here can quote the key it rejected, and this
        # key may belong to the user rather than to us.
        from .credentials import redact

        log.warning("OpenAI hosted search failed (%s): %s", type(e).__name__, redact(str(e)))
        return []


def _citations_from_response(response: Any, max_results: int) -> list[dict[str, Any]]:
    """Pull {title, snippet, url} out of a Responses API result.

    Walks the output defensively: the shape has changed across SDK versions and
    an attribute error here would look like "search is broken" to the user.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    text = (getattr(response, "output_text", "") or "").strip()

    for item in getattr(response, "output", None) or []:
        for block in getattr(item, "content", None) or []:
            block_text = (getattr(block, "text", "") or "").strip()
            for ann in getattr(block, "annotations", None) or []:
                if getattr(ann, "type", "") != "url_citation":
                    continue
                url = getattr(ann, "url", "") or ""
                if not url or url in seen:
                    continue
                seen.add(url)
                # The cited span is the sentence the model wrote about that
                # source — a better snippet than a search-engine teaser.
                start = getattr(ann, "start_index", None)
                end = getattr(ann, "end_index", None)
                if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(block_text):
                    snippet = block_text[start:end]
                else:
                    snippet = block_text[:240] or text[:240]
                out.append({
                    "title": getattr(ann, "title", "") or url,
                    "snippet": snippet[:500].strip(),
                    "url": url,
                })
                if len(out) >= max_results:
                    return out
    return out


# ── 1b. Groq hosted search (gpt-oss `browser_search`) ───────────────────────
#: Groq's citation markers, e.g. 【2†L6-L10】 — meaningless outside Groq.
_GROQ_MARKER_RE = re.compile(r"【[^】]*】")
_URL_RE = re.compile(r"""https?://[^\s)\]】"'<>]+""")


async def _groq_search(
    query: str, max_results: int, api_key: str | None = None,
) -> list[dict[str, Any]]:
    """Ask gpt-oss on Groq to search with its built-in browser tool.

    Groq runs the search itself (Exa-backed) and bills it to `api_key` — the
    caller's own key, never the server's. Streaming is not documented for this
    tool, so it is a single non-streaming call with a hard timeout and no
    retries: a slow hosted search must fall through to the free tiers, not hold
    the turn.
    """
    global _groq_search_paused_until
    if not api_key:
        return []
    if time.monotonic() < _groq_search_paused_until:
        log.info("Groq browser search paused after a 429 — using the free tiers")
        return []
    try:
        from openai import AsyncOpenAI, RateLimitError

        client = AsyncOpenAI(
            api_key=api_key, base_url=config.GROQ_BASE_URL,
            timeout=_GROQ_SEARCH_TIMEOUT_S, max_retries=0,
        )
        today = time.strftime("%d %B %Y")
        response = await client.chat.completions.create(
            model=config.GROQ_SEARCH_MODEL,
            messages=[{
                "role": "user",
                "content": (
                    f"Today is {today}. Search the web for this query and report what each "
                    "source says as dense factual notes: concrete numbers, prices with "
                    "currency, spec figures, dates. State each source's publish date when "
                    f"visible. Query: {query}"
                ),
            }],
            tools=[{"type": "browser_search"}],  # type: ignore[list-item]
            tool_choice="required",
            # Groq's own advice for this tool: low effort keeps the browsing
            # session short, which is most of its latency and token cost.
            reasoning_effort="low",
            max_completion_tokens=800,
        )
        message = response.choices[0].message
        results = groq_results(message, max_results)
        if not results:
            extra = getattr(message, "model_extra", None) or {}
            log.warning(
                "Groq browser search: no usable sources (message fields: %s)",
                sorted(set(extra) | {"content"}),
            )
        return results
    except RateLimitError:
        _groq_search_paused_until = time.monotonic() + _GROQ_429_PAUSE_S
        log.warning("Groq browser search rate-limited — pausing the tier for %.0fs", _GROQ_429_PAUSE_S)
        return []
    except Exception as e:  # noqa: BLE001
        from .credentials import redact

        log.warning("Groq browser search failed (%s): %s", type(e).__name__, redact(str(e)))
        return []


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        value = obj.get(name)
    else:
        value = getattr(obj, name, None)
        if value is None:
            value = (getattr(obj, "model_extra", None) or {}).get(name)
    return default if value is None else value


def groq_results(message: Any, max_results: int) -> list[dict[str, Any]]:
    """{title, snippet, url} from a Groq browser_search response message.

    Groq documents the request but not the shape of a browser_search entry in
    `executed_tools` — its only published example is the code tool, which
    carries `search_results: {results: ...}`. So this reads that structure when
    it is present and, failing that, recovers URLs from the tool's raw `output`.
    A result without a real URL is never returned: a citation chip that links
    nowhere is worse than falling through to a tier that has URLs.
    """
    notes = _GROQ_MARKER_RE.sub("", str(_field(message, "content", "") or "")).strip()
    tools = _field(message, "executed_tools", []) or []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(title: str, url: str, snippet: str) -> None:
        url = url.strip().rstrip(".,;")
        if not url.startswith("http") or url in seen or len(out) >= max_results:
            return
        seen.add(url)
        out.append({
            "title": (title or url).strip()[:200],
            "snippet": _GROQ_MARKER_RE.sub("", snippet or "").strip()[:500],
            "url": url,
        })

    for tool in tools:
        search = _field(tool, "search_results")
        for r in (_field(search, "results", []) or []) if search else []:
            add(
                str(_field(r, "title", "")),
                str(_field(r, "url", "")),
                str(_field(r, "content", "") or _field(r, "snippet", "")),
            )
    if not out:
        for tool in tools:
            for url in _URL_RE.findall(str(_field(tool, "output", "") or "")):
                add(url, url, "")
    # Sources found but no per-source text: the model's notes are the snippet.
    if out and not any(r["snippet"] for r in out):
        for r in out:
            r["snippet"] = notes[:500]
    return out


# ── 2. Tavily ────────────────────────────────────────────────────────────────
async def _tavily_search(query: str, max_results: int) -> list[dict[str, Any]]:
    if not config.TAVILY_API_KEY:
        return []
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.post(
                "https://api.tavily.com/search",
                json={
                    "query": query,
                    "max_results": max_results,
                    "search_depth": "basic",
                },
                headers={"Authorization": f"Bearer {config.TAVILY_API_KEY}"},
            )
            if r.status_code != 200:
                log.warning("Tavily HTTP %s: %s", r.status_code, r.text[:200])
                return []
            data = r.json()
            return [
                {
                    "title": item.get("title", ""),
                    "snippet": item.get("content", ""),
                    "url": item.get("url", ""),
                }
                for item in data.get("results", [])
            ]
    except Exception as e:  # noqa: BLE001
        log.warning("Tavily search failed: %s", e)
    return []


# ── 3. Scraping (last resort — see the module docstring) ─────────────────────
async def _scrape_search(query: str, max_results: int) -> list[dict[str, Any]]:
    """One `ddgs` attempt in `auto` mode, bounded, then the relevance filter.

    Only `auto` is worth trying. Measured on ddgs 9.14: every engine named on
    its own (duckduckgo, brave, mojeek, google, startpage) fails within a
    second, while `auto` — which fans out and leads with Wikipedia — returns
    on-topic results in ~4.5s. The old ladder's second and third attempts
    named engines ("html", "lite") that no longer exist and could never return
    anything; they only added a sleep each.
    """
    loop = asyncio.get_running_loop()
    try:
        raw = await asyncio.wait_for(
            loop.run_in_executor(_SCRAPE_POOL, _blocking_scrape, query, max_results),
            timeout=_SCRAPE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        # The thread is abandoned, not cancelled: it finishes on its own in the
        # scrape pool, which is why that pool is separate from the default one.
        log.warning("scrape timed out after %.0fs", _SCRAPE_TIMEOUT_S)
        return []
    except Exception as e:  # noqa: BLE001
        log.warning("scrape failed: %s", e)
        return []
    if not raw:
        log.info("scrape returned 0")
        return []
    kept = _filter_relevant(query, raw, "scrape")
    if kept:
        log.info("scrape -> %d usable result(s)", len(kept))
    else:
        log.warning("scrape returned only off-topic results")
    return kept


def _blocking_scrape(query: str, max_results: int) -> list[dict[str, Any]]:
    # `duckduckgo_search` was renamed to `ddgs`; import the new name first and
    # fall back so an un-migrated environment keeps working.
    try:
        from ddgs import DDGS  # type: ignore[import-not-found]
    except ImportError:
        from duckduckgo_search import DDGS  # type: ignore[no-redef]

    out: list[dict[str, Any]] = []
    with DDGS(timeout=_SCRAPE_ENGINE_TIMEOUT_S) as ddgs:
        try:
            iterable = ddgs.text(query, max_results=max_results, region="wt-wt", backend="auto")
        except TypeError:
            # Older/newer API without one of those kwargs.
            iterable = ddgs.text(query, max_results=max_results)

        for r in iterable:
            out.append({
                "title": r.get("title", ""),
                # `ddgs` renamed the snippet field; accept either.
                "snippet": r.get("body") or r.get("description") or "",
                "url": r.get("href") or r.get("url") or "",
            })
    return out


# ── Wikipedia (always reachable, no auth) ────────────────────────────────────
async def _wikipedia_search(query: str, max_results: int) -> list[dict[str, Any]]:
    """Use Wikipedia's opensearch API + summary endpoint."""
    out: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=_WIKI_TIMEOUT_S, follow_redirects=True) as client:
            # Step 1: find matching page titles.
            r = await client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "opensearch",
                    "search": query,
                    "limit": str(max_results),
                    "namespace": "0",
                    "format": "json",
                },
                headers={"User-Agent": USER_AGENT},
            )
            if r.status_code != 200:
                return []
            data = r.json()
            titles: list[str] = data[1] if len(data) > 1 else []
            urls: list[str] = data[3] if len(data) > 3 else []

            # Step 2: a short summary for each title — fetched concurrently.
            # One after another, each with its own timeout, this was the slowest
            # part of a search that had already fallen through two tiers.
            async def summary(title: str, url: str) -> dict[str, Any] | None:
                try:
                    sr = await client.get(
                        # quote_plus encodes spaces as "+", which this path
                        # rejects — every multi-word title 404'd. The REST API
                        # wants underscores, percent-encoded.
                        f"https://en.wikipedia.org/api/rest_v1/page/summary/"
                        f"{quote(title.replace(' ', '_'), safe='')}",
                        headers={"User-Agent": USER_AGENT},
                    )
                    if sr.status_code != 200:
                        return None
                    sd = sr.json()
                    return {
                        "title": sd.get("title") or title,
                        "snippet": (sd.get("extract") or "")[:500],
                        "url": sd.get("content_urls", {}).get("desktop", {}).get("page") or url,
                    }
                except Exception as e:  # noqa: BLE001
                    log.debug("wiki summary fetch failed for %r: %s", title, e)
                    return None

            pairs = list(zip(titles, urls))[: min(max_results, _WIKI_MAX_SUMMARIES)]
            fetched = await asyncio.gather(*(summary(t, u) for t, u in pairs))
            out.extend(r for r in fetched if r)
    except Exception as e:  # noqa: BLE001
        log.warning("Wikipedia search failed: %s", e)
    return out


# ── Formatting ───────────────────────────────────────────────────────────────
def format_results(results: list[dict[str, Any]]) -> str:
    if not results:
        return ""
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}\n   {r['snippet']}\n   {r['url']}")
    return "\n".join(lines)
