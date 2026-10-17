"""Search-query autocomplete, proxied through the backend.

The suggestion endpoints send no `Access-Control-Allow-Origin` header, so a
browser cannot call them directly — every keystroke has to be relayed from
here. Google is primary and DuckDuckGo is the fallback; both answer with the
same `["query", ["suggestion", ...]]` shape, which is why the swap is trivial.

These are the endpoints the browsers' own search bars use. They're undocumented
rather than contractual, so treat availability as best-effort: a failure here
returns an empty list and the composer simply shows nothing.
"""
from __future__ import annotations

import logging
import time
from collections import OrderedDict
from typing import Any

import httpx

log = logging.getLogger("universalcb.suggest")

_CACHE_TTL = 300  # 5 minutes
# Unlike a search cache this is keyed by every prefix the user types, so it
# grows once per keystroke. Bounded and evicted oldest-first.
_CACHE_MAX = 500
_cache: OrderedDict[tuple[str, str], tuple[float, list[str]]] = OrderedDict()

MAX_SUGGESTIONS = 6
# Long enough to cover a real query, short enough that nobody can use this as a
# free proxy for arbitrary upstream traffic.
MAX_QUERY_LEN = 100

_UA = "Mozilla/5.0 (compatible; Nexus/0.3; +autocomplete)"


def _cached(key: tuple[str, str]) -> list[str] | None:
    hit = _cache.get(key)
    if not hit:
        return None
    if time.time() - hit[0] >= _CACHE_TTL:
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return hit[1]


def _store(key: tuple[str, str], items: list[str]) -> None:
    _cache[key] = (time.time(), items)
    _cache.move_to_end(key)
    while len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)


def _clean(raw: Any, query: str) -> list[str]:
    """Normalise an upstream payload into de-duplicated suggestion strings."""
    out: list[str] = []
    seen: set[str] = set()
    lowered = query.strip().lower()
    for item in raw if isinstance(raw, list) else []:
        # DDG's default shape is [{"phrase": "..."}]; the list shapes are plain strings.
        text = item.get("phrase") if isinstance(item, dict) else item
        if not isinstance(text, str):
            continue
        text = text.strip()
        key = text.lower()
        # Echoing what the user already typed back at them wastes a row.
        if not text or key == lowered or key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= MAX_SUGGESTIONS:
            break
    return out


async def suggest(query: str, lang: str = "en") -> list[str]:
    """Autocomplete candidates for a partial query. Never raises."""
    q = query.strip()[:MAX_QUERY_LEN]
    if not q:
        return []
    hl = (lang or "en").split("-")[0].lower()[:5] or "en"
    key = (q.lower(), hl)

    cached = _cached(key)
    if cached is not None:
        return cached

    items: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=3.5, headers={"User-Agent": _UA}) as client:
            items = await _google(client, q, hl)
            if not items:
                items = await _duckduckgo(client, q)
    except Exception as e:  # noqa: BLE001 — autocomplete must never break typing
        log.debug("suggest failed for %r: %s", q, e)

    # Only cache real answers, so a transient upstream blip isn't pinned for
    # five minutes on a prefix the user is still typing through.
    if items:
        _store(key, items)
    return items


async def _google(client: httpx.AsyncClient, q: str, hl: str) -> list[str]:
    r = await client.get(
        "https://suggestqueries.google.com/complete/search",
        params={"client": "firefox", "q": q, "hl": hl},
    )
    if r.status_code != 200:
        log.debug("google suggest HTTP %s", r.status_code)
        return []
    data = r.json()
    return _clean(data[1] if isinstance(data, list) and len(data) > 1 else [], q)


async def _duckduckgo(client: httpx.AsyncClient, q: str) -> list[str]:
    r = await client.get("https://duckduckgo.com/ac/", params={"q": q, "type": "list"})
    if r.status_code != 200:
        log.debug("ddg suggest HTTP %s", r.status_code)
        return []
    data = r.json()
    # type=list gives ["q", [...]]; the default gives [{"phrase": ...}].
    payload = data[1] if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list) else data
    return _clean(payload, q)
