"""Checks the deterministic identity fast path.

Run: python -m backend.identity_test

A false positive here is worse than a miss — it would hijack a real question and
answer it with boilerplate — so the "must NOT match" list is the important half.
"""

from __future__ import annotations

from .identity import match_identity_intent, org_name, product_name

SHOULD_MATCH = [
    "who build you",
    "who built you",
    "who made you",
    "who created you",
    "Who built you?",
    "which company built you",
    "what company made you",
    "who developed this ai",
    "who owns this app",
    "so who built you",
    "hey who made you",
    "tell me who built you",
    "who are you",
    "what are you",
    "who are you exactly",
    "who is this bot",
    "are you chatgpt",
    "are you gpt 4",
    "are you claude",
    "r u chatgpt",
    "are you openai",
]

SHOULD_NOT_MATCH = [
    # Ordinary questions that merely look similar.
    "who built the Eiffel Tower",
    "who created the first computer",
    "which company built the iPhone",
    "who are the founders of OpenAI",
    "what are you able to do with my documents",
    "who built you and what can you do",          # compound → let the model answer
    "can you tell me who built the pyramids",
    "what is in my document about who made it",
    "are you sure about that",
    "are you able to search the web",
    "who wrote this report",
    "summarize who built the bridge",
    "",
    "hello",
    "what is rag",
]


def main() -> int:
    failures = 0

    for text in SHOULD_MATCH:
        got = match_identity_intent(text)
        ok = bool(got)
        print(f"{'PASS' if ok else 'FAIL'}  match    {text!r}" + ("" if ok else "  → no match"))
        if not ok:
            failures += 1

    for text in SHOULD_NOT_MATCH:
        got = match_identity_intent(text)
        ok = got is None
        print(f"{'PASS' if ok else 'FAIL'}  no-match {text!r}" + ("" if ok else f"  → {got!r}"))
        if not ok:
            failures += 1

    # Every canned answer must actually name the product and the org.
    for text in SHOULD_MATCH:
        reply = match_identity_intent(text) or ""
        if product_name() not in reply or org_name() not in reply:
            print(f"FAIL  content  {text!r} → {reply!r}")
            failures += 1

    total = len(SHOULD_MATCH) * 2 + len(SHOULD_NOT_MATCH)
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
