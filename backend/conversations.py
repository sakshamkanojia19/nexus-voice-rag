"""Conversation history in Supabase Postgres, so chats follow the account.

Before this, conversations lived only in the browser's `localStorage`: they did
not survive clearing site data, and they did not exist on a second device. This
module is the server side of making them sync.

Two rules shape everything here.

**Ownership is never taken from the request.** Every function takes an
`owner_key` that the caller got from `auth.Principal`, which comes from a
verified JWT or a server-issued cookie. The composite primary key
`(owner_key, id)` means a query cannot accidentally cross accounts even if a
WHERE clause is forgotten — the key itself is scoped.

**Sync is an enhancement, never a dependency.** Supabase may be unconfigured,
the table may not exist yet, the network may be down. In every one of those
cases these functions log and return an empty/False result instead of raising,
and the app carries on with its local cache. A chat app that refuses to chat
because history could not be saved is worse than one that quietly saves later.

Talks to PostgREST over httpx rather than pulling in the Supabase SDK: the one
thing we need is four REST calls, and httpx is already a dependency for JWKS.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from . import config

log = logging.getLogger("universalcb.conversations")

_TABLE = "conversations"
#: A single conversation is read and written whole, so this bounds one payload.
MAX_MESSAGES_PER_CONVERSATION = 200
#: How many conversations the sidebar will ever show.
MAX_CONVERSATIONS = 100
_TIMEOUT = 8.0

#: Logged once rather than per request — a missing table would otherwise emit a
#: warning on every keystroke-triggered sync.
_warned: set[str] = set()


def _warn_once(key: str, message: str, *args: Any) -> None:
    if key in _warned:
        return
    _warned.add(key)
    log.warning(message, *args)


def available() -> bool:
    """True when history *can* be synced. Callers degrade rather than fail."""
    return bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_ROLE_KEY)


def _endpoint() -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{_TABLE}"


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    # The service role bypasses RLS, which is why the table has no policies and
    # why this key must never reach the browser.
    headers = {
        "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def _log_failure(action: str, response: httpx.Response) -> None:
    if response.status_code in (404, 400) and _TABLE in response.text:
        _warn_once(
            "missing-table",
            "conversation sync is off: the `%s` table does not exist yet. "
            "Run backend/migrations/001_conversations.sql in the Supabase SQL editor.",
            _TABLE,
        )
        return
    log.warning("conversation %s failed: HTTP %s %s", action, response.status_code, response.text[:200])


async def list_meta(owner_key: str) -> list[dict[str, Any]]:
    """Conversation headers for the sidebar — no message bodies.

    Deliberately excludes `messages`: the list is rendered on every load, and
    shipping every message of every conversation to draw a list of titles would
    be megabytes for a heavy user.
    """
    if not available():
        return []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                _endpoint(),
                headers=_headers(),
                params={
                    "owner_key": f"eq.{owner_key}",
                    "select": "id,title,updated_at",
                    "order": "updated_at.desc",
                    "limit": str(MAX_CONVERSATIONS),
                },
            )
        if r.status_code != 200:
            _log_failure("list", r)
            return []
        return r.json()
    except Exception as e:  # noqa: BLE001
        log.warning("conversation list failed: %s", e)
        return []


async def get(owner_key: str, conversation_id: str) -> dict[str, Any] | None:
    """One conversation, messages included."""
    if not available():
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                _endpoint(),
                headers=_headers(),
                params={
                    "owner_key": f"eq.{owner_key}",
                    "id": f"eq.{conversation_id}",
                    "select": "id,title,messages,updated_at",
                    "limit": "1",
                },
            )
        if r.status_code != 200:
            _log_failure("get", r)
            return None
        rows = r.json()
        return rows[0] if rows else None
    except Exception as e:  # noqa: BLE001
        log.warning("conversation get failed: %s", e)
        return None


async def upsert(
    owner_key: str,
    conversation_id: str,
    title: str,
    messages: list[dict[str, Any]],
) -> bool:
    """Create or replace a conversation. Returns whether it was stored."""
    if not available():
        return False
    # Trim here rather than trusting the client: this is the boundary where an
    # oversized payload would become an oversized row.
    trimmed = messages[-MAX_MESSAGES_PER_CONVERSATION:]
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                _endpoint(),
                headers=_headers({
                    # Upsert on the composite key, and don't ship the row back.
                    "Prefer": "resolution=merge-duplicates,return=minimal",
                }),
                params={"on_conflict": "owner_key,id"},
                json={
                    "owner_key": owner_key,
                    "id": conversation_id,
                    "title": (title or "New chat")[:200],
                    "messages": trimmed,
                },
            )
        if r.status_code not in (200, 201, 204):
            _log_failure("upsert", r)
            return False
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("conversation upsert failed: %s", e)
        return False


async def delete(owner_key: str, conversation_id: str) -> bool:
    if not available():
        return False
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.delete(
                _endpoint(),
                headers=_headers({"Prefer": "return=minimal"}),
                params={"owner_key": f"eq.{owner_key}", "id": f"eq.{conversation_id}"},
            )
        if r.status_code not in (200, 204):
            _log_failure("delete", r)
            return False
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("conversation delete failed: %s", e)
        return False
