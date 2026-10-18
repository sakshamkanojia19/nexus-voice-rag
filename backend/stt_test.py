"""Covers the parts of stt.py that decide *what text comes back*.

Transcription accuracy is the ceiling on answer quality — a word Whisper gets
wrong is a word the model then reasons from — so the two mechanisms that guard
it are worth pinning down:

  * the fallback ladder, which must never silently substitute a *larger* model
    or claim a downgrade did not happen;
  * the hallucination filter, which is the only thing standing between a fan
    running in the background and "Thanks for watching!" being answered as a
    question.

Neither needs the model weights, so this runs in milliseconds and without a
download. Decoding itself is faster-whisper's business, not ours.

Run: python -m backend.stt_test
"""
from __future__ import annotations

import contextlib

from . import config, stt


@contextlib.contextmanager
def _settings(**overrides):
    """Swap config values for the duration of a test, then put them back."""
    previous = {k: getattr(config, k) for k in overrides}
    for k, v in overrides.items():
        setattr(config, k, v)
    try:
        yield
    finally:
        for k, v in previous.items():
            setattr(config, k, v)


@contextlib.contextmanager
def _loaded(name: str | None):
    """Pretend a given model is (or is not) resident, without loading one."""
    previous = stt._local_model_name
    stt._local_model_name = name
    try:
        yield
    finally:
        stt._local_model_name = previous


# ── The fallback ladder ─────────────────────────────────────────────────────
def test_configured_model_is_tried_first() -> None:
    for name in ("large-v3-turbo", "base", "tiny", "some-custom-finetune"):
        with _settings(LOCAL_WHISPER_MODEL=name, LOCAL_WHISPER_ALLOW_DOWNGRADE=True):
            assert stt._load_candidates()[0] == name, name


def test_ladder_only_ever_descends() -> None:
    """A fallback that loaded something bigger would fail for the same reason."""
    order = stt._MODEL_LADDER
    for name in order:
        with _settings(LOCAL_WHISPER_MODEL=name, LOCAL_WHISPER_ALLOW_DOWNGRADE=True):
            candidates = stt._load_candidates()
            positions = [order.index(c) for c in candidates if c in order]
            assert positions == sorted(positions), f"{name} -> {candidates}"
            assert len(set(candidates)) == len(candidates), f"duplicate in {candidates}"


def test_default_model_reaches_the_bottom_of_the_ladder() -> None:
    """The point of the ladder is that *some* tier always loads."""
    with _settings(LOCAL_WHISPER_MODEL="large-v3-turbo", LOCAL_WHISPER_ALLOW_DOWNGRADE=True):
        assert stt._load_candidates()[-1] == "tiny"


def test_unknown_model_still_gets_safe_fallbacks() -> None:
    """A local path or a fine-tune has no position on the ladder, but a machine
    that cannot load it still needs a working voice turn."""
    with _settings(LOCAL_WHISPER_MODEL="/models/my-finetune", LOCAL_WHISPER_ALLOW_DOWNGRADE=True):
        candidates = stt._load_candidates()
        assert candidates[0] == "/models/my-finetune"
        assert candidates[1:] == ["small", "base", "tiny"]


def test_downgrade_can_be_switched_off() -> None:
    """Someone who needs a known tier must be able to fail loudly instead."""
    with _settings(LOCAL_WHISPER_MODEL="large-v3-turbo", LOCAL_WHISPER_ALLOW_DOWNGRADE=False):
        assert stt._load_candidates() == ["large-v3-turbo"]


def test_blank_model_setting_does_not_produce_an_empty_candidate() -> None:
    with _settings(
        LOCAL_WHISPER_MODEL="  ", LOCAL_WHISPER_DEVICE="cpu", LOCAL_WHISPER_ALLOW_DOWNGRADE=True
    ):
        assert "" not in stt._load_candidates()
        assert stt._load_candidates()[0] == "base"


# ── "auto" model selection ──────────────────────────────────────────────────
def test_auto_picks_an_interactive_model_on_cpu() -> None:
    """The load-bearing one.

    This path only runs when the browser's recognizer already failed, so the
    user is sitting there waiting. Measured on an 8-core CPU at int8, decoding a
    4.7 s clip: base 3.1 s, small 9.1 s, large-v3-turbo 18.2 s. Anything above
    `base` is slower than realtime, and a transcriber that takes four times the
    length of the utterance has stopped being usable however accurate it is.
    """
    with _settings(LOCAL_WHISPER_MODEL="auto", LOCAL_WHISPER_DEVICE="cpu"):
        assert stt._configured_model() == "base"


def test_auto_takes_the_accuracy_on_a_gpu() -> None:
    """The latency argument above is a CPU argument; on a GPU it does not apply."""
    for device in ("cuda", "CUDA", "cuda:1"):
        with _settings(LOCAL_WHISPER_MODEL="auto", LOCAL_WHISPER_DEVICE=device):
            assert stt._configured_model() == "large-v3-turbo", device


def test_auto_is_case_insensitive_and_trimmed() -> None:
    for value in ("auto", "AUTO", "  Auto  "):
        with _settings(LOCAL_WHISPER_MODEL=value, LOCAL_WHISPER_DEVICE="cpu"):
            assert stt._configured_model() == "base", repr(value)


def test_an_explicit_model_always_beats_auto_selection() -> None:
    """Someone who accepts the latency must be able to ask for it and get it."""
    for name in ("large-v3-turbo", "small", "/models/custom"):
        with _settings(LOCAL_WHISPER_MODEL=name, LOCAL_WHISPER_DEVICE="cpu"):
            assert stt._configured_model() == name, name


def test_auto_resolves_before_the_ladder_is_built() -> None:
    """Otherwise 'auto' would be attempted as a literal model name."""
    with _settings(
        LOCAL_WHISPER_MODEL="auto", LOCAL_WHISPER_DEVICE="cpu", LOCAL_WHISPER_ALLOW_DOWNGRADE=True
    ):
        candidates = stt._load_candidates()
        assert "auto" not in candidates
        assert candidates[0] == "base"


def test_auto_is_reported_resolved_on_health() -> None:
    """`configured: "auto"` would tell an operator nothing about what is running."""
    with _loaded("base"), _settings(LOCAL_WHISPER_MODEL="auto", LOCAL_WHISPER_DEVICE="cpu"):
        status = stt.local_model_status()
        assert status["configured"] == "base"
        # Resolving to base and loading base is not a downgrade.
        assert status["downgraded"] is False


# ── Status reporting ────────────────────────────────────────────────────────
def test_status_reports_nothing_loaded_before_first_use() -> None:
    with _loaded(None), _settings(LOCAL_WHISPER_MODEL="large-v3-turbo"):
        status = stt.local_model_status()
        assert status["loaded"] is None
        assert status["configured"] == "large-v3-turbo"
        # Nothing is loaded, so nothing was downgraded — reporting True here
        # would show a permanent false alarm on a server that has yet to
        # transcribe anything.
        assert status["downgraded"] is False


def test_status_flags_a_silent_downgrade() -> None:
    with _loaded("base"), _settings(LOCAL_WHISPER_MODEL="large-v3-turbo"):
        status = stt.local_model_status()
        assert status["loaded"] == "base"
        assert status["downgraded"] is True, "a substituted model was reported as fine"


def test_status_is_quiet_when_the_configured_model_loaded() -> None:
    with _loaded("large-v3-turbo"), _settings(LOCAL_WHISPER_MODEL="large-v3-turbo"):
        assert stt.local_model_status()["downgraded"] is False


def test_status_never_triggers_a_load() -> None:
    """/health is called constantly; it must not pull 800 MB off disk."""
    with _loaded(None):
        stt.local_model_status()
        assert stt._local_model is None
        assert stt._local_model_name is None


# ── Hallucination filtering ─────────────────────────────────────────────────
#: Values a healthy segment reports, so each test varies one thing at a time.
GOOD_NO_SPEECH = 0.1
GOOD_LOGPROB = -0.3


def test_real_speech_survives() -> None:
    for text in (
        "what is elon musk's net worth",
        "मुझे बताओ",
        "yes",
        "Tell me about the Tesla earnings report.",
    ):
        assert stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB), text


def test_subtitle_boilerplate_is_dropped() -> None:
    """Whisper was trained on subtitle tracks and emits these over silence."""
    for text in (
        "Thanks for watching!",
        "thank you for watching",
        "Thank you.",
        "Thank you very much.",
        "Please subscribe",
        "Subtitles by the Amara.org community",
        "Subs by www.zeoranger.co.uk",
        "Transcription by ESO. Translated by —",
        "www.mooji.org",
        "महादेव",
    ):
        assert not stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB), text


def test_empty_and_whitespace_are_dropped() -> None:
    for text in ("", "   ", "\n\t", None):
        assert not stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB), repr(text)


def test_a_segment_the_model_calls_silence_is_dropped() -> None:
    assert not stt._keep_segment("hello there", 0.95, GOOD_LOGPROB)


def test_a_segment_the_model_is_unsure_of_is_dropped() -> None:
    assert not stt._keep_segment("hello there", GOOD_NO_SPEECH, -2.5)


def test_the_thresholds_leave_normal_speech_room() -> None:
    """Calibration guard: real segments sit well inside these bounds, and
    tightening them until they do not is how a working feature gets broken."""
    assert stt._keep_segment("what is the capital of france", 0.5, -0.8)
    assert stt._keep_segment("i went to the store yesterday", 0.7, -1.0)


def test_the_filter_matches_whole_segments_only() -> None:
    """A boilerplate phrase *inside* a real sentence is a real sentence."""
    for text in (
        "thank you for watching the presentation, what did you think",
        "should i thank you for that",
        "tell me about www.tesla.com and its history",
    ):
        assert stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB), text


def test_punctuation_and_case_do_not_smuggle_boilerplate_through() -> None:
    for text in ("THANKS FOR WATCHING!!", "  thank you...  ", "- Thanks for watching -"):
        assert not stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB), text


# ── Prompt echo ─────────────────────────────────────────────────────────────
# Biasing the decoder with an initial_prompt is what stops "RAG" being heard as
# "drag". The price is that on silence the prompt itself becomes the strongest
# signal present and gets transcribed back. These guard that trade.
PROMPT = "A spoken question for Nexus about RAG, LLM, Nexus, Qdrant, embeddings, vector database, API key."


def test_the_prompt_read_back_is_dropped() -> None:
    for text in (
        PROMPT,
        "A spoken question for Nexus about RAG, LLM, Nexus, Qdrant.",
        "Nexus RAG LLM Qdrant embeddings vector database",
    ):
        assert not stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB, PROMPT), text


def test_a_real_question_using_prompted_words_survives() -> None:
    """The whole point of the prompt is that people say these words. Filtering
    every sentence containing them would be worse than not prompting at all."""
    for text in (
        "what is RAG",
        "how does RAG work with embeddings",
        "tell me about the Qdrant vector database and how it stores things",
        "explain LLM context windows to me",
    ):
        assert stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB, PROMPT), text


def test_a_looping_echo_of_prompt_terms_is_dropped() -> None:
    """Captured: Whisper answered short audio with its own vocabulary on loop."""
    prompt = "A spoken question for Nexus about RAG, LLM, Nexus, Qdrant, embeddings, vector database, API key."
    loop = "LLM, Nexus, Qdrant, embeddings, Qdrant, and Qdrant, embeddings, Qdrant, and Qdrant, are you?"
    assert stt._is_prompt_echo(loop, prompt)
    for real in (
        "What is Qdrant and how does it store embeddings?",
        "Nexus, how are you?",
        "How do I add my API key to Nexus?",
    ):
        assert not stt._is_prompt_echo(real, prompt), real


def test_prompt_echo_filtering_is_inert_without_a_prompt() -> None:
    for text in ("what is RAG", "Nexus Qdrant embeddings"):
        assert stt._keep_segment(text, GOOD_NO_SPEECH, GOOD_LOGPROB, ""), text


def test_prompt_echo_handles_degenerate_input() -> None:
    assert stt._is_prompt_echo("", PROMPT) is False
    assert stt._is_prompt_echo("hello", "") is False
    # A prompt of only short words primes nothing, and must not reject everything.
    assert stt._is_prompt_echo("hello there", "a an of to") is False


# ── Language handling ───────────────────────────────────────────────────────
def test_iso639_normalises_bcp47_tags() -> None:
    assert stt._iso639("hi-IN") == "hi"
    assert stt._iso639("en-US") == "en"
    assert stt._iso639("EN") == "en"
    assert stt._iso639(" en-GB ") == "en"


def test_iso639_returns_blank_rather_than_a_bad_guess() -> None:
    """A wrong `language=` forces Whisper to decode in the wrong language, which
    is worse than letting it detect."""
    for value in ("", "   ", "eng", "x", None):
        assert stt._iso639(value) == "", repr(value)


def test_hosted_segments_get_the_local_filter() -> None:
    """Groq/OpenAI Whisper over speaker bleed returns confident-sounding text
    with a high no-speech probability; that must not become a user turn."""
    result = {
        "text": "What is pizza? I'm sorry.",
        "segments": [
            {"text": " What is pizza?", "no_speech_prob": 0.02, "avg_logprob": -0.2},
            {"text": " I'm sorry.", "no_speech_prob": 0.93, "avg_logprob": -0.4},
        ],
    }
    assert stt._hosted_text(result) == "What is pizza?"


def test_hosted_segments_read_sdk_objects_too() -> None:
    """The OpenAI SDK hands back attribute objects, not dicts."""
    class Seg:
        def __init__(self, text, nsp, lp):
            self.text, self.no_speech_prob, self.avg_logprob = text, nsp, lp

    class Result:
        text = "ignored"
        segments = [Seg(" Who made you?", 0.01, -0.1), Seg(" Thank you.", 0.1, -0.3)]

    assert stt._hosted_text(Result()) == "Who made you?"


def test_hosted_all_noise_comes_back_empty() -> None:
    result = {"text": "And I will tell you.", "segments": [
        {"text": " And I will tell you.", "no_speech_prob": 0.9, "avg_logprob": -0.5},
    ]}
    assert stt._hosted_text(result) == ""


def test_hosted_plain_text_still_drops_boilerplate_and_prompt_echo() -> None:
    """gpt-4o transcribe models return no segments — the text checks still run."""
    assert stt._hosted_text({"text": "Thanks for watching!"}) == ""
    prompt = "Nexus, RAG, Qdrant, retrieval"
    assert stt._hosted_text({"text": "Nexus RAG Qdrant retrieval"}, prompt) == ""
    assert stt._hosted_text({"text": "How does Qdrant store vectors?"}, prompt) == (
        "How does Qdrant store vectors?"
    )


def test_only_whisper_models_are_asked_for_segments() -> None:
    assert stt._reports_segments("whisper-large-v3-turbo")
    assert stt._reports_segments("whisper-1")
    assert not stt._reports_segments("gpt-4o-mini-transcribe")


# ── Fallback policy: who pays when hosted transcription fails ────────────────
def _route(*, backend: str, fallback: bool, provider, hosted_fails: bool = False):
    """Run stt.transcribe with fake backends; report which ran and the outcome."""
    import asyncio

    ran: list[str] = []

    async def fake_hosted(*a, **k):
        ran.append("hosted")
        if hosted_fails:
            raise RuntimeError("429 rate limited")
        return "hosted text"

    async def fake_local(*a, **k):
        ran.append("local")
        return "local text"

    saved = (stt.transcribe_hosted, stt.transcribe_local)
    stt.transcribe_hosted, stt.transcribe_local = fake_hosted, fake_local
    try:
        with _settings(STT_BACKEND=backend, LOCAL_STT_FALLBACK=fallback):
            try:
                out = asyncio.run(stt.transcribe(b"x", "a.wav", api_key="key", provider=provider))
            except stt.SttUnavailable:
                out = "UNAVAILABLE"
    finally:
        stt.transcribe_hosted, stt.transcribe_local = saved
    return ran, out


def test_hosted_failure_fails_fast_when_local_fallback_is_off() -> None:
    """A rate-limited user key must not turn into CPU decoding on the server."""
    from .providers import GROQ
    ran, out = _route(backend="openai", fallback=False, provider=GROQ, hosted_fails=True)
    assert ran == ["hosted"] and out == "UNAVAILABLE", (ran, out)


def test_hosted_failure_falls_back_locally_when_allowed() -> None:
    from .providers import GROQ
    ran, out = _route(backend="openai", fallback=True, provider=GROQ, hosted_fails=True)
    assert ran == ["hosted", "local"] and out == "local text", (ran, out)


def test_a_provider_without_transcription_never_reaches_local_when_off() -> None:
    from .providers import XAI
    ran, out = _route(backend="openai", fallback=False, provider=XAI)
    assert ran == [] and out == "UNAVAILABLE", (ran, out)


def test_local_backend_is_unaffected_by_the_switch() -> None:
    """Local first is the whole point of STT_BACKEND=local; the switch only
    governs the server decoding on a hosted deployment's behalf."""
    from .providers import GROQ
    ran, out = _route(backend="local", fallback=False, provider=GROQ)
    assert ran == ["local"] and out == "local text", (ran, out)


def test_local_fallback_defaults_follow_the_backend() -> None:
    assert config._bool(None, "local" == "local") is True
    assert config._bool(None, "openai" == "local") is False


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
