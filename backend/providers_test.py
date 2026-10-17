"""Enforces that a key only ever travels to the provider it belongs to.

The failure these guard against is quiet: an xAI or Groq key sent to OpenAI's
endpoint still produces a plausible-looking error, and a request that falls back
to the server's OpenAI key still produces a plausible-looking answer — billed to
the operator, for someone who chose to pay for their own usage.

Run: python -m backend.providers_test
"""
from __future__ import annotations

import asyncio

from fastapi import HTTPException

from . import agent, providers, stt, web_search
from .agent import _LLM_CACHE, _get_llm
from .credentials import LEGACY_KEY_HEADER, USER_KEY_HEADER, get_credentials, redact, requested_provider
from .credentials_test import OTHER, SIGNED_IN, VALID, _FakeRequest, _settings
from .providers import GROQ, OPENAI, XAI
from .vectorstore import DocumentStore

XAI_KEY = "xai-" + "A1b2C3d4E5f6G7h8" * 5
GROQ_KEY = "gsk_" + "Z9y8X7w6V5u4T3s2" * 3


# ── Key → provider ───────────────────────────────────────────────────────────
def test_each_key_is_routed_to_its_own_provider() -> None:
    assert providers.for_key(VALID) is OPENAI
    assert providers.for_key("sk-proj-AbC123_def-456ghiJKL789mnopqrst") is OPENAI
    assert providers.for_key(XAI_KEY) is XAI
    assert providers.for_key(GROQ_KEY) is GROQ
    for junk in ("", "xai-short", "gsk_short", "gsk-" + "a" * 40, f"Bearer {XAI_KEY}"):
        assert providers.for_key(junk) is None, f"{junk[:20]!r} was accepted"


def test_user_keys_carry_their_provider_through_credentials() -> None:
    with _settings(ALLOW_USER_API_KEYS=True):
        for key, want in ((VALID, OPENAI), (XAI_KEY, XAI), (GROQ_KEY, GROQ)):
            creds = get_credentials(_FakeRequest({USER_KEY_HEADER: key}), SIGNED_IN)
            assert creds.provider is want and creds.api_key == key and creds.user_supplied


def test_the_old_header_name_still_works() -> None:
    """A tab opened before the upgrade sends X-OpenAI-Key until it reloads."""
    with _settings(ALLOW_USER_API_KEYS=True):
        creds = get_credentials(_FakeRequest({LEGACY_KEY_HEADER: VALID}), SIGNED_IN)
    assert creds.api_key == VALID and creds.provider is OPENAI


def test_unknown_key_is_rejected_without_echoing_it() -> None:
    with _settings(ALLOW_USER_API_KEYS=True):
        try:
            get_credentials(_FakeRequest({USER_KEY_HEADER: "pk-SENT1NELabcdefghijklmnop"}), SIGNED_IN)
        except HTTPException as e:
            assert e.status_code == 400 and "SENT1NEL" not in str(e.detail)
        else:
            raise AssertionError("an unrecognised key was accepted")


def test_server_key_belongs_to_the_configured_provider() -> None:
    with _settings(PROVIDER="groq", GROQ_API_KEY=GROQ_KEY, OPENAI_API_KEY=OTHER,
                   REQUIRE_USER_API_KEY=False):
        creds = get_credentials(_FakeRequest(), SIGNED_IN)
    assert creds.provider is GROQ and creds.api_key == GROQ_KEY


def test_model_list_follows_the_callers_key() -> None:
    with _settings(ALLOW_USER_API_KEYS=True, PROVIDER="openai"):
        assert requested_provider(_FakeRequest({USER_KEY_HEADER: XAI_KEY})) is XAI
        assert requested_provider(_FakeRequest({USER_KEY_HEADER: "garbage"})) is OPENAI
        assert requested_provider(_FakeRequest()) is OPENAI


def test_redaction_covers_every_provider_format() -> None:
    for key, prefix in ((VALID, "sk-"), (XAI_KEY, "xai-"), (GROQ_KEY, "gsk_")):
        out = redact(f"Error code: 401 - Incorrect API key provided: {key}.")
        assert key not in out, f"{prefix} key survived redaction"
        assert f"{prefix}***redacted***" in out and "Error code: 401" in out


# ── Chat client ──────────────────────────────────────────────────────────────
def test_chat_client_points_at_the_keys_provider() -> None:
    with _settings(OPENAI_API_KEY=OTHER, PROVIDER="openai"):
        _LLM_CACHE.clear()
        xai = _get_llm("grok-4", None, XAI_KEY, XAI)
        groq = _get_llm("llama-3.3-70b-versatile", None, GROQ_KEY, GROQ)
        assert "x.ai" in str(xai.openai_api_base)
        assert "groq.com" in str(groq.openai_api_base)
        assert xai.use_responses_api is False and groq.use_responses_api is False
        assert not _LLM_CACHE, "a user's non-OpenAI key was written into the shared cache"
        _LLM_CACHE.clear()


def test_cache_is_partitioned_by_provider() -> None:
    """Same model id, two providers' server keys: two distinct clients."""
    with _settings(OPENAI_API_KEY=OTHER, GROQ_API_KEY=GROQ_KEY):
        _LLM_CACHE.clear()
        a = _get_llm("openai/gpt-oss-20b", None, provider=OPENAI)
        b = _get_llm("openai/gpt-oss-20b", None, provider=GROQ)
        assert a is not b and len(_LLM_CACHE) == 2
        _LLM_CACHE.clear()


def test_sampling_options_match_what_each_model_accepts() -> None:
    so = providers.sampling_options
    assert so(OPENAI, "gpt-4o", "high") == {"temperature": 0.5}
    assert so(OPENAI, "o4-mini", None) == {"reasoning_effort": "medium"}
    assert so(XAI, "grok-4.20-0309-non-reasoning", "high") == {"temperature": 0.5}
    assert so(XAI, "grok-4.7", None) == {"reasoning_effort": "low"}, "an ordinary turn should stay fast"
    assert so(XAI, "grok-4.7", "medium") == {"reasoning_effort": "medium"}
    assert so(XAI, "grok-4.20-0309-reasoning", "high") == {}, "undocumented: send nothing"
    assert so(XAI, "grok-3-mini", "medium") == {"reasoning_effort": "high"}
    assert so(GROQ, "openai/gpt-oss-120b", None) == {"reasoning_effort": "low"}
    assert so(GROQ, "openai/gpt-oss-20b", "high") == {"reasoning_effort": "high"}
    assert so(GROQ, "llama-3.3-70b-versatile", "high") == {"temperature": 0.5}


def test_every_default_model_is_on_its_own_allowlist() -> None:
    """A role's default the picker can't offer is a sign the two lists drifted."""
    for p in (XAI, GROQ):
        m = providers.models(p)
        for role in ("default", "voice", "quick_voice", "instant", "deep", "thinking"):
            assert getattr(m, role) in m.chat, f"{p.id}.{role}={getattr(m, role)!r} not in its chat list"


def test_a_retired_model_is_named_in_the_error() -> None:
    import httpx
    import openai

    from .main import _upstream_error

    r = httpx.Response(404, request=httpx.Request("POST", "https://api.groq.com"))
    body = {"message": "The model `llama-3.1-8b-instant` has been decommissioned", "type": "invalid_request_error"}
    out = _upstream_error(openai.NotFoundError("404", response=r, body=body), GROQ)
    assert "llama-3.1-8b-instant" in out and out.startswith("Groq doesn't recognise")


# ── Features a provider lacks stay unavailable ───────────────────────────────
def _web_search_key_for(api_key: str, provider: providers.Provider) -> list:
    seen: list = []

    async def fake_search(query: str, max_results: int = 5, api_key: str | None = None):
        seen.append(api_key)
        return []

    real = web_search.search
    web_search.search = fake_search
    try:
        tools = agent.build_tools("owner", None, [], api_key=api_key, provider=provider)
        tool = next(t for t in tools if t.name == "search_web")
        asyncio.run(tool.ainvoke({"query": "anything"}))
    finally:
        web_search.search = real
    return seen


def test_hosted_web_search_only_ever_receives_an_openai_key() -> None:
    assert _web_search_key_for(VALID, OPENAI) == [VALID]
    assert _web_search_key_for(XAI_KEY, XAI) == [None], "xAI key was handed to OpenAI search"
    assert _web_search_key_for(GROQ_KEY, GROQ) == [None], "Groq key was handed to OpenAI search"


def test_web_search_does_not_fall_back_to_the_server_openai_key() -> None:
    """None must mean 'skip hosted search', not 'use the operator's key'."""
    called: list = []

    async def fake_openai(query, max_results, api_key=None):
        called.append(api_key)
        return [{"title": "t", "url": "u", "snippet": "s"}]

    real = web_search._openai_search
    web_search._openai_search = fake_openai
    try:
        with _settings(OPENAI_API_KEY=OTHER, TAVILY_API_KEY="tvly-x"):
            async def fake_tavily(q, n):
                return [{"title": "tav", "url": "u", "snippet": "s"}]
            real_tavily = web_search._tavily_search
            web_search._tavily_search = fake_tavily
            try:
                asyncio.run(web_search._dispatch("auto", "q", 5, None))
            finally:
                web_search._tavily_search = real_tavily
    finally:
        web_search._openai_search = real
    assert called == [], f"hosted search ran on the server key: {called}"


def test_document_tool_refuses_providers_without_embeddings() -> None:
    class _Store:
        async def search(self, *a, **k):
            raise AssertionError("embedding was attempted on an xAI key")

    tools = agent.build_tools("owner", _Store(), [], api_key=XAI_KEY, provider=XAI)
    tool = next(t for t in tools if t.name == "search_documents")
    out = asyncio.run(tool.ainvoke({"query": "my notes"}))
    assert "OpenAI key" in out


def test_vector_store_never_embeds_on_another_providers_key() -> None:
    store = DocumentStore.__new__(DocumentStore)  # skip the Qdrant connection
    for key in (XAI_KEY, GROQ_KEY):
        try:
            store._vs_for(key)
        except RuntimeError:
            pass
        else:
            raise AssertionError(f"{key[:4]} key reached OpenAIEmbeddings")


def _transcribe_with(provider: providers.Provider, key: str, backend: str) -> list:
    calls: list = []

    async def fake_local(*a, **k):
        calls.append(("local", None))
        return "local"

    async def fake_hosted(audio, filename, prompt, language, api_key, p):
        calls.append(("hosted", p.id))
        return "hosted"

    real = stt.transcribe_local, stt.transcribe_hosted
    stt.transcribe_local, stt.transcribe_hosted = fake_local, fake_hosted
    try:
        with _settings(STT_BACKEND=backend):
            asyncio.run(stt.transcribe(b"x", "a.webm", "", "", key, provider))
    finally:
        stt.transcribe_local, stt.transcribe_hosted = real
    return calls


def test_transcription_stays_on_the_keys_provider() -> None:
    assert _transcribe_with(GROQ, GROQ_KEY, "openai") == [("hosted", "groq")]
    assert _transcribe_with(OPENAI, VALID, "openai") == [("hosted", "openai")]
    # xAI has no hosted transcription: local only, never OpenAI's endpoint.
    assert _transcribe_with(XAI, XAI_KEY, "openai") == [("local", None)]


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
