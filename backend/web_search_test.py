"""Exercises the relevance guard against the real failures seen in production.

Every "reject" case below is an actual result the scraped tier returned at
HTTP 200 for the query beside it. The guard exists so those never reach the
model as context or the user as a citation.

Run: python -m pytest backend/web_search_test.py   (or: python backend/web_search_test.py)
"""
from __future__ import annotations

from . import config
from .web_search import _filter_relevant, _relevance, _terms


def _r(title: str, snippet: str = "", url: str = "") -> dict:
    return {"title": title, "snippet": snippet, "url": url}


# ── Cases ────────────────────────────────────────────────────────────────────
# (query, result, should_be_kept)
CASES: list[tuple[str, dict, bool]] = [
    # ── Real off-topic results the scraper returned. All must be REJECTED. ──
    ("Elon Musk recent project 2026",
     _r("iLovePDF: PDF Editor & Scanner - Apps on Google Play", "", "play.google.com"), False),
    ("Elon Musk recent project 2026",
     _r("WhatsApp Messenger - Apps on Google Play", "", "play.google.com"), False),
    ("Elon Musk total revenue 2026",
     _r("Snail Mucin - COSRX Official", "", "cosrx.com"), False),
    ("Elon Musk total revenue 2026",
     _r("COSRX Advanced Snail 96 Mucin Power Essence 100 ml", "", "alodokter.com"), False),
    ("Elon Musk biography and latest news",
     _r("0.275 as a fraction in simplest form - Calculatio", "", "calculat.io"), False),
    ("Elon Musk biography and latest news",
     _r("Donald Trump - Wikipedia", "Donald John Trump is an American politician",
        "en.wikipedia.org/wiki/Donald_Trump"), False),
    ("Elon Musk biography and latest news",
     _r("ANZ Personal - Bank accounts, home loans, credit cards", "", "anz.com.au"), False),

    # ── Genuine results for the same queries. All must be KEPT. ──
    ("Elon Musk recent project 2026",
     _r("Elon Musk - Wikipedia", "Elon Reeve Musk is a businessman known for his key roles "
        "in Tesla and SpaceX", "en.wikipedia.org/wiki/Elon_Musk"), True),
    ("Elon Musk total revenue 2026",
     _r("Tesla Q4 revenue climbs", "Musk said total revenue rose", "reuters.com"), True),
    ("Elon Musk biography and latest news",
     _r("Elon Musk | Biography, SpaceX, Tesla, & Facts", "", "britannica.com"), True),
    # Matching on the URL alone is enough — some engines return empty snippets.
    ("Elon Musk recent project 2026", _r("", "", "https://www.tesla.com/elon-musk"), True),
    # A partial match still counts: "musk" alone carries the topic.
    ("what is the total revenue of Elon Musk",
     _r("Musk's net worth", "", "forbes.com"), True),

    # ── The guard must not reject on absence of evidence. ──
    # Nothing meaningful to match against, so nothing can be judged off-topic.
    ("the a of", _r("Anything at all", "", "example.com"), True),
]


def test_relevance_cases() -> None:
    failures: list[str] = []
    for query, result, should_keep in CASES:
        score = _relevance(query, result)
        kept = score >= config.WEB_SEARCH_MIN_RELEVANCE
        if kept != should_keep:
            failures.append(
                f"{'keep' if should_keep else 'reject'} {result['title'] or result['url']!r} "
                f"for {query!r} — score {score:.2f}, got {'kept' if kept else 'rejected'}"
            )
    assert not failures, "relevance guard mismatches:\n  " + "\n  ".join(failures)


def test_every_observed_failure_shares_no_term_at_all() -> None:
    """The property the threshold is calibrated against.

    Every off-topic result seen in production scores exactly zero — it has no
    meaningful word in common with the query. That is what makes a low
    (recall-friendly) threshold safe: the guard does not need to make fine
    judgements, only to notice "about something else entirely".
    """
    for query, result, should_keep in CASES:
        if not should_keep and _terms(query):
            score = _relevance(query, result)
            assert score == 0.0, (
                f"{result['title']!r} scored {score:.2f} for {query!r}; the threshold is "
                "calibrated on off-topic results scoring 0, so this case needs review"
            )


def test_stopwords_alone_do_not_make_a_match() -> None:
    """'latest news about X' must not be satisfied by a page about 'news'."""
    score = _relevance("latest news about Elon Musk", _r("The Latest News", "news news news"))
    assert score == 0.0, f"stopword-only match scored {score}"


def test_filter_drops_the_whole_batch_when_the_tier_is_blocked() -> None:
    """The observed failure mode: eight confident, entirely unrelated results."""
    blocked = [
        _r("Snail Mucin - COSRX Official", "", "cosrx.com"),
        _r("COSRX Indonesia | Official Korean Skincare Store", "", "cosrx.co.id"),
        _r("Jual Cosrx Snail Mucin Terlengkap", "", "tokopedia.com"),
    ]
    kept = _filter_relevant("Elon Musk total revenue 2026", blocked, "test")
    assert kept == [], f"expected an empty result set, kept {len(kept)}"


def test_filter_keeps_good_results_untouched() -> None:
    good = [
        _r("Elon Musk - Wikipedia", "Elon Reeve Musk", "en.wikipedia.org/wiki/Elon_Musk"),
        _r("Elon Musk news", "latest on Musk", "reuters.com/musk"),
    ]
    assert _filter_relevant("Elon Musk latest news", good, "test") == good


def test_threshold_of_zero_disables_the_guard() -> None:
    original = config.WEB_SEARCH_MIN_RELEVANCE
    config.WEB_SEARCH_MIN_RELEVANCE = 0.0
    try:
        junk = [_r("Snail Mucin", "", "cosrx.com")]
        assert _filter_relevant("Elon Musk", junk, "test") == junk
    finally:
        config.WEB_SEARCH_MIN_RELEVANCE = original


def test_terms_strips_digits_and_punctuation() -> None:
    assert _terms("Elon Musk's revenue, 2026!") == {"elon", "musk", "revenue"}


# ── Groq browser_search parsing ─────────────────────────────────────────────
def test_groq_structured_results_become_sources() -> None:
    from .web_search import groq_results
    message = {
        "content": "THAAD is a US missile defence system 【1†L3-L9】.",
        "executed_tools": [{
            "type": "browser_search",
            "search_results": {"results": [
                {"title": "THAAD - Wikipedia", "url": "https://en.wikipedia.org/wiki/THAAD",
                 "content": "Terminal High Altitude Area Defense 【0†L1-L2】 is…", "score": 0.9},
                {"title": "Missile Defense Agency", "url": "https://www.mda.mil/system/thaad.html",
                 "content": "THAAD intercepts…"},
            ]},
        }],
    }
    out = groq_results(message, 5)
    assert [r["url"] for r in out] == [
        "https://en.wikipedia.org/wiki/THAAD", "https://www.mda.mil/system/thaad.html",
    ], out
    assert all("【" not in r["snippet"] for r in out), out


def test_groq_urls_are_recovered_from_raw_output() -> None:
    from .web_search import groq_results
    message = {
        "content": "Notes about pizza 【2†L6-L10】",
        "executed_tools": [{"type": "browser_search", "output": (
            "【0†Pizza - Wikipedia†https://en.wikipedia.org/wiki/Pizza】 L0: ... "
            "see also https://www.britannica.com/topic/pizza."
        )}],
    }
    out = groq_results(message, 5)
    assert [r["url"] for r in out] == [
        "https://en.wikipedia.org/wiki/Pizza", "https://www.britannica.com/topic/pizza",
    ], out
    assert out[0]["snippet"] == "Notes about pizza", out


def test_groq_without_urls_returns_nothing_so_the_ladder_continues() -> None:
    from .web_search import groq_results
    assert groq_results({"content": "some notes", "executed_tools": []}, 5) == []
    assert groq_results({"content": "some notes"}, 5) == []


def test_groq_results_respect_max_and_dedupe() -> None:
    from .web_search import groq_results
    results = [{"title": f"t{i}", "url": f"https://x.com/{i % 3}", "content": "c"} for i in range(9)]
    out = groq_results({"executed_tools": [{"search_results": {"results": results}}]}, 2)
    assert [r["url"] for r in out] == ["https://x.com/0", "https://x.com/1"], out


def test_groq_results_read_sdk_style_objects() -> None:
    """The OpenAI SDK puts unknown fields like executed_tools in model_extra."""
    from .web_search import groq_results

    class Msg:
        content = "notes"
        model_extra = {"executed_tools": [{"search_results": {"results": [
            {"title": "A", "url": "https://a.example/x", "content": "alpha"}]}}]}

    assert [r["url"] for r in groq_results(Msg(), 5)] == ["https://a.example/x"]


# ── Time budget ──────────────────────────────────────────────────────────────
def test_a_stalled_ladder_gives_up_within_the_budget() -> None:
    import asyncio
    import time as _time
    from . import web_search as ws

    async def stall(*a, **k):
        await asyncio.sleep(30)
        return [{"title": "late", "url": "https://late", "snippet": ""}]

    saved = (ws._dispatch, ws._SEARCH_BUDGET_S)
    ws._dispatch, ws._SEARCH_BUDGET_S = stall, 0.3
    try:
        t = _time.monotonic()
        out = asyncio.run(ws.search("never cached query xyz"))
        elapsed = _time.monotonic() - t
    finally:
        ws._dispatch, ws._SEARCH_BUDGET_S = saved
    assert out == [] and elapsed < 2, (out, elapsed)

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}\n      {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
