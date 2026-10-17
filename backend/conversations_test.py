"""Conversation history: ownership isolation, and degrading without Supabase.

Two properties, both of which fail silently if they regress:

* **A caller can only ever reach their own conversations.** Ids are generated in
  the browser, so they are guessable; the only thing standing between one
  account and another's transcript is that every query is scoped by the verified
  `owner_key`.
* **Sync never becomes a hard dependency.** With Supabase unconfigured, or the
  table missing, the app must keep working from its local cache rather than
  erroring — a chat app that refuses to chat because history could not be saved
  is worse than one that saves later.

Runs fully offline: PostgREST is replaced with a fake, so no project is touched.

Run: python -m backend.conversations_test
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi.testclient import TestClient

from . import config, conversations

_failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  → {detail}" if not ok and detail else ""))
    if not ok:
        _failures += 1


@contextlib.contextmanager
def _settings(**overrides: Any):
    original = {k: getattr(config, k) for k in overrides}
    for k, v in overrides.items():
        setattr(config, k, v)
    try:
        yield
    finally:
        for k, v in original.items():
            setattr(config, k, v)


# ── Degradation ──────────────────────────────────────────────────────────────
def test_unconfigured_supabase_degrades_quietly() -> None:
    """No URL or key: every call returns empty rather than raising."""
    with _settings(SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY=""):
        check("available() is False when unconfigured", conversations.available() is False)

        async def run() -> None:
            check("list_meta returns []", await conversations.list_meta("user:a") == [])
            check("get returns None", await conversations.get("user:a", "x") is None)
            check("upsert returns False", await conversations.upsert("user:a", "x", "t", []) is False)
            check("delete returns False", await conversations.delete("user:a", "x") is False)

        asyncio.run(run())


def test_routes_answer_without_supabase() -> None:
    """The endpoints must serve an empty history, not a 500."""
    import backend.main as m

    with _settings(SUPABASE_URL="", SUPABASE_SERVICE_ROLE_KEY="", REQUIRE_AUTH=False):
        c = TestClient(m.app)
        r = c.get("/conversations")
        check("GET /conversations is 200 with sync off", r.status_code == 200, str(r.status_code))
        check("…and reports itself unsynced", r.json().get("synced") is False)
        check("…with an empty list", r.json().get("conversations") == [])

        r = c.put("/conversations/abc", json={"title": "t", "messages": []})
        check("PUT reports not-saved rather than failing", r.status_code == 200 and r.json() == {"saved": False})

        r = c.get("/conversations/abc")
        check("GET of a missing conversation is 404", r.status_code == 404, str(r.status_code))


# ── Ownership isolation ──────────────────────────────────────────────────────
class _FakeRows:
    """A stand-in PostgREST holding rows keyed by (owner_key, id).

    Modelling the composite key is the point: it is what makes cross-account
    reads impossible, so the fake has to enforce it the way Postgres would.
    """

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        self.seen_params: list[dict[str, Any]] = []

    def _owner(self, params: dict[str, Any]) -> str:
        return str(params.get("owner_key", "")).removeprefix("eq.")

    def _id(self, params: dict[str, Any]) -> str:
        return str(params.get("id", "")).removeprefix("eq.")

    async def get(self, url: str, headers: Any = None, params: Any = None) -> Any:
        params = params or {}
        self.seen_params.append(dict(params))
        owner, rid = self._owner(params), self._id(params)
        matched = [
            row for (o, i), row in self.rows.items()
            if o == owner and (not rid or i == rid)
        ]
        return _FakeResponse(200, matched)

    async def post(self, url: str, headers: Any = None, params: Any = None, json: Any = None) -> Any:
        body = json or {}
        self.rows[(body["owner_key"], body["id"])] = {
            "id": body["id"],
            "title": body["title"],
            "messages": body["messages"],
            "updated_at": "2026-01-01T00:00:00Z",
        }
        return _FakeResponse(201, None)

    async def delete(self, url: str, headers: Any = None, params: Any = None) -> Any:
        params = params or {}
        self.rows.pop((self._owner(params), self._id(params)), None)
        return _FakeResponse(204, None)


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self) -> Any:
        return self._payload


@contextlib.contextmanager
def _fake_postgrest(fake: _FakeRows):
    import httpx

    class _Client:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        async def __aenter__(self) -> _FakeRows:
            return fake

        async def __aexit__(self, *exc: object) -> None:
            return None

    original = httpx.AsyncClient
    httpx.AsyncClient = _Client  # type: ignore[assignment,misc]
    try:
        yield
    finally:
        httpx.AsyncClient = original  # type: ignore[assignment,misc]


def test_one_account_cannot_read_another() -> None:
    fake = _FakeRows()
    with _settings(SUPABASE_URL="https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY="svc"), _fake_postgrest(fake):
        async def run() -> None:
            await conversations.upsert("user:alice", "c1", "Alice's chat", [{"role": "user", "content": "secret"}])

            mine = await conversations.list_meta("user:alice")
            check("owner sees their own conversation", len(mine) == 1 and mine[0]["id"] == "c1")

            theirs = await conversations.list_meta("user:bob")
            check("another account sees nothing", theirs == [], str(theirs))

            # Guessing the id must not help: the row key includes the owner.
            stolen = await conversations.get("user:bob", "c1")
            check("guessing a conversation id does not cross accounts", stolen is None, str(stolen))

            # Nor may they delete it.
            await conversations.delete("user:bob", "c1")
            still_there = await conversations.get("user:alice", "c1")
            check("another account cannot delete it either", still_there is not None)

            # Every query really was scoped — belt and braces on the fake.
            check(
                "every read filtered on owner_key",
                all("owner_key" in p for p in fake.seen_params),
            )

        asyncio.run(run())


def test_round_trip_and_delete() -> None:
    fake = _FakeRows()
    with _settings(SUPABASE_URL="https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY="svc"), _fake_postgrest(fake):
        async def run() -> None:
            msgs = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]
            check("upsert succeeds", await conversations.upsert("user:a", "c", "Title", msgs) is True)

            got = await conversations.get("user:a", "c")
            check("get returns the messages", got is not None and got["messages"] == msgs)
            check("get returns the title", got is not None and got["title"] == "Title")

            check("delete succeeds", await conversations.delete("user:a", "c") is True)
            check("deleted conversation is gone", await conversations.get("user:a", "c") is None)

        asyncio.run(run())


def test_oversized_history_is_trimmed_at_the_boundary() -> None:
    """The server, not the client, decides how big a row may get."""
    fake = _FakeRows()
    with _settings(SUPABASE_URL="https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY="svc"), _fake_postgrest(fake):
        async def run() -> None:
            huge = [{"role": "user", "content": f"m{i}"} for i in range(conversations.MAX_MESSAGES_PER_CONVERSATION + 50)]
            await conversations.upsert("user:a", "big", "Big", huge)
            stored = (await conversations.get("user:a", "big")) or {}
            kept = stored.get("messages", [])
            check(
                "history is capped server-side",
                len(kept) == conversations.MAX_MESSAGES_PER_CONVERSATION,
                f"kept {len(kept)}",
            )
            check("the most RECENT messages are the ones kept", kept[-1]["content"] == huge[-1]["content"])

        asyncio.run(run())


def main() -> int:
    test_unconfigured_supabase_degrades_quietly()
    test_routes_answer_without_supabase()
    test_one_account_cannot_read_another()
    test_round_trip_and_delete()
    test_oversized_history_is_trimmed_at_the_boundary()
    print(f"\n{'all checks passed' if not _failures else f'{_failures} check(s) failed'}")
    return 1 if _failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
