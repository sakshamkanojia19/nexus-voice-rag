"""Speech-to-text: pluggable backend (OpenAI hosted or faster-whisper local)."""
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import sys
import sysconfig
import tempfile
import threading
import time
from pathlib import Path

from . import config, providers
from .providers import Provider

log = logging.getLogger("universalcb.stt")

_local_model = None
_local_model_name: str | None = None
_local_model_device: str | None = None
# Loading takes tens of seconds and ~800 MB. Two voice turns arriving together
# would otherwise both miss the `is not None` check and build a second model —
# doubling the memory and, on a cold machine, the download.
_load_lock = threading.Lock()

# Ordered largest-to-smallest. Used only to pick what to try after a failed
# load; the configured model is always attempted first whether or not it is
# listed here, so a local path or a name we do not know still works.
_MODEL_LADDER = ("large-v3-turbo", "distil-large-v3", "medium", "small", "base", "tiny")


#: What "auto" resolves to, per device. These are measured, not assumed.
#:
#: On an 8-core CPU at int8, decoding a 4.7 s clip took: base 3.1 s (0.7x
#: realtime), small 9.1 s (1.9x), large-v3-turbo 18.2 s (3.9x), distil-large-v3
#: 21.3 s (4.6x). Only `base` finishes faster than the audio it is transcribing.
#: A more accurate model that takes twenty seconds is not a better transcriber
#: in a live conversation — it is a broken one, because this path only runs when
#: the browser's own recognizer has already failed and the user is *waiting*.
#:
#: On a GPU that constraint disappears and the accuracy is simply worth having,
#: so the same setting resolves to the near-best model instead.
_AUTO_MODEL_BY_DEVICE = {"cuda": "large-v3-turbo", "cpu": "base"}


def _configured_model() -> str:
    """The requested model name, normalised and resolved.

    Stripping happens *before* the default is applied: `LOCAL_WHISPER_MODEL=" "`
    is a blank setting, not a model called " ", and letting it through produces
    a load that fails for a reason nobody can read.
    """
    name = (config.LOCAL_WHISPER_MODEL or "").strip() or "auto"
    if name.lower() != "auto":
        return name
    device = (config.LOCAL_WHISPER_DEVICE or "cpu").strip().lower()
    # "cuda:1" and friends are still cuda.
    key = "cuda" if device.startswith("cuda") else "cpu"
    return _AUTO_MODEL_BY_DEVICE[key]


def _load_candidates() -> list[str]:
    """The configured model, then anything smaller worth falling back to."""
    configured = _configured_model()
    if not config.LOCAL_WHISPER_ALLOW_DOWNGRADE:
        return [configured]
    if configured in _MODEL_LADDER:
        smaller = _MODEL_LADDER[_MODEL_LADDER.index(configured) + 1:]
    else:
        # An unrecognised name (custom path, fine-tune) has no known position on
        # the ladder, so fall back to tiers that are safe on any machine.
        smaller = ("small", "base", "tiny")
    return [configured, *smaller]


_dll_dirs_added = False


def _add_nvidia_dll_dirs() -> None:
    """Make pip-installed CUDA runtime DLLs loadable on Windows.

    ctranslate2 links against cuBLAS/cuDNN at runtime rather than bundling
    them. On Linux the `nvidia-*-cu12` wheels land on the loader path
    automatically; on Windows they sit in `site-packages/nvidia/<lib>/bin`
    where LoadLibrary never looks, and the model load dies with
    "Library cublas64_12.dll is not found". Registering those directories is
    the difference between the GPU working and the GPU being silently unusable.
    """
    global _dll_dirs_added
    if _dll_dirs_added or sys.platform != "win32":
        return
    _dll_dirs_added = True
    site_packages = Path(sysconfig.get_paths()["purelib"])
    for sub in ("cublas", "cudnn"):
        bin_dir = site_packages / "nvidia" / sub / "bin"
        if bin_dir.is_dir():
            os.add_dll_directory(str(bin_dir))
            # ctranslate2 loads via plain LoadLibrary, which searches PATH.
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
            log.info("registered CUDA DLL directory: %s", bin_dir)


def _build_model(name: str, device: str | None = None, compute: str | None = None):
    from faster_whisper import WhisperModel

    device = device or config.LOCAL_WHISPER_DEVICE
    if device.lower().startswith("cuda"):
        _add_nvidia_dll_dirs()
    kwargs: dict = {
        "device": device,
        "compute_type": compute or config.LOCAL_WHISPER_COMPUTE,
    }
    if config.LOCAL_WHISPER_CPU_THREADS > 0:
        kwargs["cpu_threads"] = config.LOCAL_WHISPER_CPU_THREADS
    return WhisperModel(name, **kwargs)


def _load_local_model():
    """Lazy-load faster-whisper. First call downloads weights — slow once.

    Falls down `_MODEL_LADDER` if the requested tier will not load, so a machine
    that cannot hold `large-v3-turbo` still gets a working voice turn rather
    than an error. The substitution is logged at WARNING and surfaced by
    `local_model_status()`.
    """
    global _local_model, _local_model_name, _local_model_device
    if _local_model is not None:
        return _local_model

    with _load_lock:
        # Re-check: another thread may have finished while we waited.
        if _local_model is not None:
            return _local_model

        try:
            import faster_whisper  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "STT_BACKEND=local requires faster-whisper. Install with: "
                "pip install faster-whisper"
            ) from e

        device = (config.LOCAL_WHISPER_DEVICE or "cpu").strip().lower()
        # (model, device, compute) attempts, best first. When the configured
        # device is a GPU, a final CPU tier is appended: a broken CUDA runtime
        # (driver update, missing DLLs) fails every size on the ladder for the
        # same reason, and without this the whole local backend — the free one —
        # dies over a problem that has nothing to do with model size.
        attempts: list[tuple[str, str, str]] = [
            (name, config.LOCAL_WHISPER_DEVICE, config.LOCAL_WHISPER_COMPUTE)
            for name in _load_candidates()
        ]
        if device.startswith("cuda"):
            cpu_ladder = [_AUTO_MODEL_BY_DEVICE["cpu"], "tiny"]
            attempts += [(name, "cpu", "int8") for name in cpu_ladder]

        errors: list[str] = []
        first = attempts[0]
        for name, dev, compute in attempts:
            try:
                log.info(
                    "Loading faster-whisper model=%s device=%s compute=%s "
                    "(first run downloads weights)",
                    name, dev, compute,
                )
                model = _build_model(name, dev, compute)
            except Exception as e:  # noqa: BLE001 — any load failure is worth a retry lower down
                errors.append(f"{name}@{dev}: {e}")
                log.warning("faster-whisper model %s (%s) failed to load: %s", name, dev, e)
                continue

            if (name, dev) != (first[0], first[1]):
                log.warning(
                    "faster-whisper fell back to %s on %s — %s on %s was requested but "
                    "would not load. Transcription accuracy is lower than configured.",
                    name, dev, first[0], first[1],
                )
            _local_model = model
            _local_model_name = name
            _local_model_device = dev
            return _local_model

        raise RuntimeError(
            "no faster-whisper model could be loaded (" + "; ".join(errors) + ")"
        )


def local_model_status() -> dict[str, object]:
    """What the local backend is actually doing, for /health.

    Reports the model that is *loaded*, which is not necessarily the one that
    was configured — see `_load_local_model`. Never triggers a load.
    """
    configured = _configured_model()
    return {
        "configured": configured,
        "loaded": _local_model_name,
        # The device actually in use can differ from the configured one when the
        # CPU rescue tier caught a broken CUDA runtime — see `_load_local_model`.
        "device": _local_model_device or config.LOCAL_WHISPER_DEVICE,
        "compute": config.LOCAL_WHISPER_COMPUTE,
        "downgraded": _local_model_name is not None and (
            _local_model_name != configured
            or (_local_model_device or config.LOCAL_WHISPER_DEVICE) != config.LOCAL_WHISPER_DEVICE
        ),
    }


#: A short spoken sentence (Windows TTS, 16 kHz mono) decoded once at boot.
_WARMUP_CLIP = Path(__file__).parent / "assets" / "warmup.wav"


def _warm_decode() -> None:
    """Load the weights AND decode a real sentence.

    Loading alone left the first real transcription paying for CUDA's lazy
    setup, measured at 16-18s for the first spoken turn on a GTX 1650 Ti
    against ~1.6s for every turn after. And the warm-up has to be *speech*:
    the decoder's kernels only load when there are tokens to emit, so a clip
    of silence or noise leaves the first real sentence at 4-5s. Measured here
    with the first real decode after each warm-up: none 15.9s, 4s of noise
    4.7s, a spoken sentence 1.6s.
    """
    started = time.perf_counter()
    if _WARMUP_CLIP.is_file():
        text = _decode_local(_WARMUP_CLIP.read_bytes(), _WARMUP_CLIP.name, "", "en")
        log.info("faster-whisper warm decode: %.1fs (%r)", time.perf_counter() - started, text)
        return
    import numpy as np

    model = _load_local_model()
    log.warning("warm-up clip %s missing — warming with noise (first real decode will be slower)", _WARMUP_CLIP)
    audio = (np.random.default_rng(0).standard_normal(16000 * 4) * 0.002).astype(np.float32)
    segments, _info = model.transcribe(
        audio, language="en", beam_size=config.LOCAL_WHISPER_BEAM_SIZE, vad_filter=False,
    )
    list(segments)  # decoding is lazy: nothing runs until the segments are read
    log.info("faster-whisper warm decode: %.1fs", time.perf_counter() - started)


async def warmup_local_model() -> None:
    """Load the weights ahead of the first voice turn, off the event loop.

    Best-effort by design: a machine that cannot load the model should still
    boot and serve text chat, and `transcribe` will fall back to hosted STT.
    """
    if config.STT_BACKEND != "local" or not config.LOCAL_WHISPER_WARMUP:
        return
    try:
        await asyncio.to_thread(_warm_decode)
        log.info("faster-whisper ready (model=%s)", _local_model_name)
    except Exception as e:  # noqa: BLE001
        log.warning("faster-whisper warm-up failed (%s) — will retry on first use", e)


def _iso639(language: str) -> str:
    """Normalise a BCP-47 tag (e.g. 'hi-IN') to ISO-639-1 ('hi') for Whisper."""
    code = (language or "").strip().lower().split("-")[0]
    return code if len(code) == 2 else ""


# ── Hallucination filtering ─────────────────────────────────────────────────
# Whisper was trained on subtitle tracks, so when handed audio with no speech in
# it — a held breath, a fan, the tail of a segment — it does not return nothing.
# It returns the most common thing at the end of a subtitle file. These are the
# stock outputs, and they arrive looking exactly like a real transcript, which
# is how "Thanks for watching!" ends up being answered as a question.
_HALLUCINATION_RE = re.compile(
    r"^\W*(?:"
    r"thanks?\s+(?:you\s+)?for\s+watching"
    r"|thank\s+you(?:\s+very\s+much)?"
    r"|please\s+subscribe"
    r"|subtitles?\s+by.*"
    r"|amara\.org.*"
    r"|subs?\s+by.*"
    r"|transcription\s+by.*"
    r"|www\..*"
    r"|महादेव"  # "महादेव" — the Hindi equivalent artifact
    r")\W*$",
    re.IGNORECASE,
)

# A segment the model itself thinks is probably silence. Whisper reports this
# per segment; the decode-level `no_speech_threshold` only suppresses a segment
# when the average log-probability is *also* poor, so a confidently-worded
# hallucination over silence slips through it.
_NO_SPEECH_PROB_MAX = 0.85
# …and one it is very unsure about. Below this the text is closer to noise than
# to a transcript.
_AVG_LOGPROB_MIN = -1.2


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[^\W_]+", (text or "").lower()) if len(w) > 2}


#: How much of a segment's vocabulary may come from the prompt before we treat
#: it as the prompt being read back rather than speech being transcribed. A real
#: answer to a prompted question reuses a term or two; an echo reuses nearly all
#: of them.
_PROMPT_ECHO_OVERLAP = 0.8


def _is_prompt_echo(text: str, prompt: str) -> bool:
    """Did Whisper transcribe our own `initial_prompt` back at us?

    Conditioning text biases the decoder toward its own vocabulary, and on
    silence or noise that bias is the strongest signal present — so the model
    emits the prompt. This is the price of the biasing that stops "RAG" being
    heard as "drag", and it has to be paid here rather than by dropping the
    prompt, because a mis-transcribed question is the worse failure.
    """
    if not prompt:
        return False
    said = _words(text)
    if not said:
        return False
    primed = _words(prompt)
    if not primed:
        return False
    return len(said & primed) / len(said) >= _PROMPT_ECHO_OVERLAP


def _keep_segment(
    text: str, no_speech_prob: float, avg_logprob: float, prompt: str = ""
) -> bool:
    """Whether one decoded segment is real speech rather than a stock artifact."""
    stripped = (text or "").strip()
    if not stripped:
        return False
    if no_speech_prob >= _NO_SPEECH_PROB_MAX:
        return False
    if avg_logprob <= _AVG_LOGPROB_MIN:
        return False
    if _HALLUCINATION_RE.match(stripped):
        return False
    if _is_prompt_echo(stripped, prompt):
        return False
    return True


async def transcribe_hosted(
    audio_bytes: bytes, filename: str, prompt: str, language: str,
    api_key: str, provider: Provider,
) -> str:
    """Hosted Whisper-family transcription on `provider`, spending `api_key`.

    OpenAI and Groq both serve the OpenAI transcription protocol, so one client
    covers both; only the endpoint and the model id differ.
    """
    model = providers.transcribe_model(provider)
    if not model:
        raise RuntimeError(f"{provider.label} has no hosted transcription")
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=api_key, base_url=provider.base_url)
    buf = io.BytesIO(audio_bytes)
    buf.name = filename or "audio.webm"
    kwargs: dict = {"model": model, "file": buf}
    if prompt:
        kwargs["prompt"] = prompt
    iso = _iso639(language)
    if iso:
        kwargs["language"] = iso  # bias Whisper to the chosen language
    if _reports_segments(model):
        # Ask for the per-segment confidences so the same filter the local path
        # runs can run here. Without them a hosted Whisper hands back its
        # captions of speaker bleed and room noise ("I'm sorry.", "And I will
        # tell you.") as plain text, and each one becomes a turn the user never
        # said. Temperature 0 because the hosted endpoints don't re-decode a
        # degenerate pass the way faster-whisper's temperature ladder does.
        kwargs["response_format"] = "verbose_json"
        kwargs["temperature"] = 0
    result = await client.audio.transcriptions.create(**kwargs)
    return _hosted_text(result, prompt)


def _reports_segments(model: str) -> bool:
    """Whisper-family models return `verbose_json` segments with confidences.
    The gpt-4o transcribe models accept only `json`/`text`."""
    return "whisper" in (model or "").lower()


def _hosted_text(result: object, prompt: str = "") -> str:
    """The transcript a hosted response carries, after the hallucination filter.

    With segments, each is judged exactly as `transcribe_local` judges its own.
    Without them (the gpt-4o models) only the text-level checks can run.
    """
    def field(obj: object, name: str, default=None):
        return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)

    segments = field(result, "segments")
    if segments:
        kept = [
            str(field(s, "text", "")).strip()
            for s in segments
            if _keep_segment(
                str(field(s, "text", "")),
                float(field(s, "no_speech_prob", 0.0) or 0.0),
                float(field(s, "avg_logprob", 0.0) or 0.0),
                prompt,
            )
        ]
        return " ".join(kept).strip()

    text = str(field(result, "text", "") or "").strip()
    if not text or _HALLUCINATION_RE.match(text) or _is_prompt_echo(text, prompt):
        return ""
    return text


async def transcribe_local(audio_bytes: bytes, filename: str, prompt: str = "", language: str = "") -> str:
    """Run faster-whisper in a thread so we don't block the event loop."""
    return await asyncio.to_thread(_decode_local, audio_bytes, filename, prompt, language)


def _decode_local(audio_bytes: bytes, filename: str, prompt: str = "", language: str = "") -> str:
    """The blocking decode behind `transcribe_local`; the warm-up calls it directly."""
    model = _load_local_model()
    suffix = Path(filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        iso = _iso639(language)
        segments, _info = model.transcribe(
            tmp_path,
            language=iso or None,
            initial_prompt=prompt or None,
            beam_size=config.LOCAL_WHISPER_BEAM_SIZE,
            # Re-decode at rising temperature when a pass looks degenerate.
            # This is what recovers a garbled segment instead of emitting it.
            temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            # The single most important flag here. Left on (the default),
            # Whisper feeds each segment its own previous output as context,
            # so one bad segment seeds the next and the model locks into
            # repeating a phrase for the rest of the clip. Our audio is one
            # short utterance where cross-segment context buys almost
            # nothing, so the trade is entirely one-sided.
            condition_on_previous_text=False,
            # Degenerate-output guards, at the library's own defaults —
            # spelled out because they are load-bearing here, not incidental.
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            # Drop stretches of near-silence rather than inviting the model
            # to caption them. The browser already trimmed the utterance, so
            # this mostly catches the tail of a thinking pause.
            vad_filter=True,
            vad_parameters={
                # A turn may span mid-sentence pauses; the frontend joins
                # those segments deliberately. Splitting on anything shorter
                # than a real gap would fight that.
                "min_silence_duration_ms": 500,
                # Keep a margin around detected speech. A clipped leading
                # consonant is a word Whisper has to guess at.
                "speech_pad_ms": 200,
            },
        )
        kept = [
            s.text.strip()
            for s in segments
            if _keep_segment(s.text, s.no_speech_prob, s.avg_logprob, prompt)
        ]
        return " ".join(kept).strip()
    finally:
        Path(tmp_path).unlink(missing_ok=True)


async def transcribe(
    audio_bytes: bytes, filename: str, prompt: str = "", language: str = "",
    api_key: str | None = None,
    provider: Provider | None = None,
) -> str:
    """Transcribe with the configured backend, degrading rather than failing.

    `local` (faster-whisper, free, on this machine) is the default so no voice
    turn costs money: the browser already handles VAD, TTS and primary STT for
    free, and this was the last paid step in the voice path.

    The two backends fail in opposite ways, so each covers the other:
    `local` needs a package installed and weights downloaded on first use, while
    `openai` needs a key and a network. Whichever is configured, we fall back to
    the other before giving up — a voice turn that returns nothing is a dead app,
    and this is the one place that decision can be made.

    "Hosted" means `provider`'s own transcription, on `api_key` — OpenAI's or
    Groq's. A provider without one (xAI) is local-only, never routed to another
    vendor's endpoint on another vendor's key.
    """
    backend = config.STT_BACKEND
    provider = provider or providers.server()
    key = api_key or providers.server_key(provider)
    hosted = bool(key) and provider.transcription

    if backend == "local" or not hosted:
        if backend != "local" and not config.LOCAL_STT_FALLBACK:
            raise SttUnavailable(f"{provider.label} has no transcription for this request")
        try:
            return await transcribe_local(audio_bytes, filename, prompt, language)
        except Exception as e:  # noqa: BLE001
            if not hosted:
                raise
            log.warning("local STT unavailable (%s) — falling back to hosted", e)
            return await transcribe_hosted(audio_bytes, filename, prompt, language, key, provider)

    try:
        return await transcribe_hosted(audio_bytes, filename, prompt, language, key, provider)
    except Exception as e:  # noqa: BLE001
        if not config.LOCAL_STT_FALLBACK:
            # Fail fast: the client falls back to the browser's transcript. See
            # config.LOCAL_STT_FALLBACK for why the server doesn't decode here.
            log.warning("hosted STT failed (%s) — local fallback off, reporting unavailable", e)
            status = getattr(e, "status_code", None)
            reason = (
                "is rate-limiting transcription on this key" if status == 429
                else "rejected the transcription request" if status in (401, 403)
                else "transcription is unavailable right now"
            )
            raise SttUnavailable(f"{provider.label} {reason}.") from e
        log.warning("hosted STT failed (%s) — falling back to local", e)
        return await transcribe_local(audio_bytes, filename, prompt, language)


class SttUnavailable(RuntimeError):
    """No transcription this server is willing to run for this request."""
