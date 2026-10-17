"""Enforces the promises credentials.py makes about user API keys.

These are security properties, not behaviour preferences: a regression here
leaks somebody's credential. They are tested rather than left to code review
because every one of them is a thing that looks harmless to "simplify" later.

Run: python -m backend.credentials_test
"""
from __future__ import annotations

import contextlib

from fastapi import HTTPException

from . import config, providers
from .agent import _LLM_CACHE, _get_llm
from .auth import Principal
from .credentials import Credentials, USER_KEY_HEADER, get_credentials, redact, require_usable

VALID = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
OTHER = "sk-zyxwvutsrqponmlkjihgfedcba9876543210"

#: A signed-in caller and a not-signed-in one. Most tests use SIGNED_IN because
#: they are about key handling, not about the gate; the gate has its own section.
SIGNED_IN = Principal(subject="uuid-1234", kind="user", email="a@example.com")
ANON = Principal(subject="anon-token-abcdefghijklmnop", kind="anon")


class _FakeRequest:
    """Minimal stand-in for a Starlette Request — only headers are read."""

    def __init__(self, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}


@contextlib.contextmanager
def _settings(**overrides):
    """Temporarily override config, restoring even if the test fails."""
    original = {k: getattr(config, k) for k in overrides}
    for k, v in overrides.items():
        setattr(config, k, v)
    try:
        yield
    finally:
        for k, v in original.items():
            setattr(config, k, v)


# ── Redaction ────────────────────────────────────────────────────────────────
def test_redact_removes_keys_from_upstream_error_text() -> None:
    """OpenAI quotes the rejected key in its 401 body. That must never survive."""
    msg = f"Error code: 401 - Incorrect API key provided: {VALID}. You can find your key at..."
    out = redact(msg)
    assert VALID not in out, "key survived redaction"
    assert "sk-***redacted***" in out
    assert "Error code: 401" in out, "redaction destroyed the useful part of the message"


def test_redact_handles_multiple_keys_and_empty_input() -> None:
    assert VALID not in redact(f"{VALID} and also {OTHER}")
    assert OTHER not in redact(f"{VALID} and also {OTHER}")
    assert redact("") == ""


def test_repr_never_contains_the_key() -> None:
    """A dataclass repr would print it the moment anything logs the object."""
    creds = Credentials(api_key=VALID, provider=providers.OPENAI, user_supplied=True)
    assert VALID not in repr(creds)
    assert VALID not in f"{creds}"
    assert VALID not in str(creds)


# ── Header handling ──────────────────────────────────────────────────────────
def test_user_key_is_used_when_supplied() -> None:
    with _settings(ALLOW_USER_API_KEYS=True):
        creds = get_credentials(_FakeRequest({USER_KEY_HEADER: VALID}), SIGNED_IN)
    assert creds.api_key == VALID
    assert creds.user_supplied is True


def test_falls_back_to_server_key_without_a_header() -> None:
    with _settings(PROVIDER="openai", OPENAI_API_KEY=OTHER, REQUIRE_USER_API_KEY=False):
        creds = get_credentials(_FakeRequest(), SIGNED_IN)
    assert creds.api_key == OTHER
    assert creds.user_supplied is False


def test_malformed_key_is_rejected_before_it_reaches_an_upstream() -> None:
    # Each carries a sentinel so the echo check tests the *value* we sent, not
    # incidental overlap with the hint text (which legitimately says "sk-").
    malformed = [
        "not-a-key-SENT1NEL",
        "sk-SENT1NEL",           # right prefix, too short to be real
        "Bearer sk-SENT1NELabcdefghijklmnop",  # a pasted header, not a key
        "sk-has spaces SENT1NEL and punctuation!",
    ]
    for bad in malformed:
        with _settings(ALLOW_USER_API_KEYS=True):
            try:
                get_credentials(_FakeRequest({USER_KEY_HEADER: bad}), SIGNED_IN)
            except HTTPException as e:
                assert e.status_code == 400, f"{bad!r} gave {e.status_code}, want 400"
                assert "SENT1NEL" not in str(e.detail), (
                    f"the rejected value was echoed back in the error: {e.detail!r}"
                )
            else:
                raise AssertionError(f"malformed key {bad!r} was accepted")


def test_absent_header_is_absence_not_a_malformed_key() -> None:
    """An empty header must fall back, not 400 — clients send it unset."""
    with _settings(ALLOW_USER_API_KEYS=True, PROVIDER="openai", OPENAI_API_KEY=OTHER, REQUIRE_USER_API_KEY=False):
        for header in ({}, {USER_KEY_HEADER: ""}, {USER_KEY_HEADER: "   "}):
            creds = get_credentials(_FakeRequest(dict(header)), SIGNED_IN)
            assert creds.api_key == OTHER and creds.user_supplied is False


def test_user_keys_ignored_when_the_feature_is_off() -> None:
    with _settings(ALLOW_USER_API_KEYS=False, PROVIDER="openai", OPENAI_API_KEY=OTHER, REQUIRE_USER_API_KEY=False):
        creds = get_credentials(_FakeRequest({USER_KEY_HEADER: VALID}), SIGNED_IN)
    assert creds.api_key == OTHER, "user key was honoured despite being disabled"
    assert creds.user_supplied is False


def test_require_user_key_refuses_to_spend_the_server_key() -> None:
    with _settings(REQUIRE_USER_API_KEY=True, PROVIDER="openai", OPENAI_API_KEY=OTHER):
        try:
            get_credentials(_FakeRequest(), SIGNED_IN)
        except HTTPException as e:
            assert e.status_code == 402
        else:
            raise AssertionError("server key was spent despite REQUIRE_USER_API_KEY")


# ── BYOK is gated on identity ────────────────────────────────────────────────
# The property: a credential is only ever accepted from someone we can name. An
# anonymous caller's key belongs to an account we cannot warn, revoke or bill.
def test_anonymous_caller_cannot_supply_a_key() -> None:
    with _settings(ALLOW_USER_API_KEYS=True, REQUIRE_AUTH_FOR_USER_KEY=True):
        try:
            get_credentials(_FakeRequest({USER_KEY_HEADER: VALID}), ANON)
        except HTTPException as e:
            assert e.status_code == 401, f"anonymous BYOK gave {e.status_code}, want 401"
            assert VALID not in str(e.detail), "the key was echoed back in the refusal"
        else:
            raise AssertionError("an anonymous caller's API key was accepted")


def test_anonymous_rejection_precedes_the_format_check() -> None:
    """A caller who has not identified themselves learns nothing about the key
    they sent — not even whether its shape is right."""
    with _settings(ALLOW_USER_API_KEYS=True, REQUIRE_AUTH_FOR_USER_KEY=True):
        try:
            get_credentials(_FakeRequest({USER_KEY_HEADER: "not-a-key-at-all"}), ANON)
        except HTTPException as e:
            assert e.status_code == 401, (
                f"a malformed key from an anonymous caller gave {e.status_code}; "
                "400 would confirm the gate runs after the format check"
            )
        else:
            raise AssertionError("an anonymous caller's malformed key was accepted")


def test_anonymous_caller_is_told_to_sign_in_not_to_add_a_key() -> None:
    """402 would point them at a door that is still locked: they cannot add a
    key until they have an account, so the first step is sign-in."""
    with _settings(REQUIRE_USER_API_KEY=True, REQUIRE_AUTH_FOR_USER_KEY=True, PROVIDER="openai", OPENAI_API_KEY=OTHER):
        try:
            get_credentials(_FakeRequest(), ANON)
        except HTTPException as e:
            assert e.status_code == 401, f"got {e.status_code}, want 401 before 402"
        else:
            raise AssertionError("server key was spent for an anonymous caller")


def test_signed_in_caller_may_supply_a_key() -> None:
    """The gate must not break the feature it protects."""
    with _settings(ALLOW_USER_API_KEYS=True, REQUIRE_AUTH_FOR_USER_KEY=True):
        creds = get_credentials(_FakeRequest({USER_KEY_HEADER: VALID}), SIGNED_IN)
    assert creds.api_key == VALID and creds.user_supplied is True


def test_gate_can_be_switched_off_for_a_private_deployment() -> None:
    """A single-user instance behind its own network has nobody to identify."""
    with _settings(ALLOW_USER_API_KEYS=True, REQUIRE_AUTH_FOR_USER_KEY=False):
        creds = get_credentials(_FakeRequest({USER_KEY_HEADER: VALID}), ANON)
    assert creds.api_key == VALID and creds.user_supplied is True


def test_require_usable_raises_when_no_key_exists_anywhere() -> None:
    try:
        require_usable(Credentials(api_key=None, provider=providers.OPENAI, user_supplied=False))
    except HTTPException as e:
        assert e.status_code == 503
    else:
        raise AssertionError("a request with no key at all was allowed through")


# ── The cache-poisoning property ─────────────────────────────────────────────
def test_user_keys_never_enter_the_shared_model_cache() -> None:
    """The one that would actually bill one user for another user's questions.

    `_LLM_CACHE` is keyed by model alone, so anything stored in it is handed to
    every subsequent caller. A user's key must therefore never be cached.
    """
    with _settings(PROVIDER="openai", OPENAI_API_KEY=OTHER):
        _LLM_CACHE.clear()

        # A server-key client is shareable, so it caches and is reused.
        first = _get_llm("gpt-4o-mini", None)
        assert len(_LLM_CACHE) == 1
        assert _get_llm("gpt-4o-mini", None) is first, "server-key client stopped being reused"

        # A user-key client must not be cached, and must not evict or replace
        # the shared one.
        user_llm = _get_llm("gpt-4o-mini", None, VALID)
        assert user_llm is not first, "user request was served the shared client"
        assert len(_LLM_CACHE) == 1, "user key was written into the shared cache"
        assert _get_llm("gpt-4o-mini", None) is first, "shared client was displaced"

        # Two user requests must not share a client either.
        assert _get_llm("gpt-4o-mini", None, VALID) is not user_llm
        _LLM_CACHE.clear()


def test_passing_the_server_key_explicitly_still_caches() -> None:
    """Otherwise every internal call that threads the key would lose reuse."""
    with _settings(PROVIDER="openai", OPENAI_API_KEY=OTHER):
        _LLM_CACHE.clear()
        a = _get_llm("gpt-4o-mini", None, OTHER)
        b = _get_llm("gpt-4o-mini", None)
        assert a is b, "explicitly passing the server key bypassed the cache"
        _LLM_CACHE.clear()


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
