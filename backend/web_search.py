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
from typing import Any
from urllib.parse import quote

import httpx

from . import config

log = logging.getLogger("universalcb.search")

_CACHE_TTL = 300  # 5 minutes
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
) -> list[dict[str, Any]]:
    """Return top results as a list of {title, snippet, url}.

    `api_key` is the OpenAI key this request may spend on hosted search — the
    caller's own, or the server's when the server runs on OpenAI. None skips the
    hosted tier. There is deliberately no fallback to the server's key here: a
    request on another provider passes None, and must not end up spending the
    operator's OpenAI credit. Results are cached by query only — the cache holds
    public search results, never anything derived from the credential.
    """
    key = f"{config.WEB_SEARCH_PROVIDER}:{query.strip().lower()}"
    now = time.time()

    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        log.info("cache hit: %r -> %d results", query, len(hit[1]))
        return hit[1]

    provider = config.WEB_SEARCH_PROVIDER
    log.info("search: %r (provider=%s)", query, provider)
    results = await _dispatch(provider, query, max_results, api_key)

    log.info("search done: %r -> %d results", query, len(results))
    if results:
        _cache[key] = (now, results)
    return results


async def _dispatch(
    provider: str, query: str, max_results: int, api_key: str | None = None,
) -> list[dict[str, Any]]:
    """Run the configured provider, or walk the ladder when set to `auto`."""
    openai_key = api_key
    if provider == "openai":
        return await _openai_search(query, max_results, openai_key)
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
    """Try several region/backend combos, then hard-filter for relevance."""
    attempts: list[dict[str, Any]] = [
        {"region": "wt-wt", "backend": "auto"},
        {"region": "us-en", "backend": "html"},
        {"region": "wt-wt", "backend": "lite"},
    ]
    for i, opts in enumerate(attempts, 1):
        try:
            raw = await asyncio.to_thread(_blocking_scrape, query, max_results, opts)
        except Exception as e:  # noqa: BLE001
            log.warning("scrape attempt %d (%s) failed: %s", i, opts, e)
            raw = []
        if raw:
            kept = _filter_relevant(query, raw, f"scrape attempt {i}")
            if kept:
                log.info("scrape attempt %d (%s) -> %d usable result(s)", i, opts, len(kept))
                return kept
            # Results came back but none were on topic: this tier is blocked
            # right now, and another region will not change that.
            log.warning("scrape attempt %d returned only off-topic results — abandoning tier", i)
            return []
        log.info("scrape attempt %d (%s) returned 0", i, opts)
        await asyncio.sleep(0.4)
    return []


def _blocking_scrape(query: str, max_results: int, opts: dict[str, Any]) -> list[dict[str, Any]]:
    # `duckduckgo_search` was renamed to `ddgs`; import the new name first and
    # fall back so an un-migrated environment keeps working.
    try:
        from ddgs import DDGS  # type: ignore[import-not-found]
    except ImportError:
        from duckduckgo_search import DDGS  # type: ignore[no-redef]

    out: list[dict[str, Any]] = []
    with DDGS() as ddgs:
        try:
            iterable = ddgs.text(
                query,
                max_results=max_results,
                region=opts.get("region", "wt-wt"),
                backend=opts.get("backend", "auto"),
            )
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
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
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

            # Step 2: pull a short summary for each title.
            for title, url in zip(titles[:max_results], urls[:max_results]):
                try:
                    sr = await client.get(
                        # quote_plus encodes spaces as "+", which this path
                        # rejects — every multi-word title 404'd. The REST API
                        # wants underscores, percent-encoded.
                        f"https://en.wikipedia.org/api/rest_v1/page/summary/"
                        f"{quote(title.replace(' ', '_'), safe='')}",
                        headers={"User-Agent": USER_AGENT},
                    )
                    if sr.status_code == 200:
                        sd = sr.json()
                        snippet = sd.get("extract") or ""
                        out.append({
                            "title": sd.get("title") or title,
                            "snippet": snippet[:500],
                            "url": sd.get("content_urls", {}).get("desktop", {}).get("page") or url,
                        })
                except Exception as e:  # noqa: BLE001
                    log.debug("wiki summary fetch failed for %r: %s", title, e)
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
