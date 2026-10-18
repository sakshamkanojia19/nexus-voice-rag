"""Which OpenAI-compatible API a request runs on.

Chat goes through `ChatOpenAI` for every provider here: xAI and Groq both serve
the OpenAI chat-completions protocol, so a different `base_url` and key is the
whole difference for the agent loop. What they do NOT share is everything
around chat — embeddings, hosted web search, hosted transcription. Each
`Provider` declares which of those it has, and a request on a provider without
one loses that feature rather than borrowing another vendor's key for it.

That last rule is the security property of this module. A user's Groq key must
only ever travel to Groq: sent to OpenAI it is a credential leak, and quietly
falling back to the server's OpenAI key instead would spend the operator's
credit on a request whose owner chose to pay for it themselves.

A caller's key is matched to its provider by prefix. The prefixes are disjoint
(`sk-`, `xai-`, `gsk_`), so the key alone is unambiguous and the client needs
no separate provider setting that could disagree with it.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from . import config

log = logging.getLogger("universalcb.providers")


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    #: None means the OpenAI SDK's own default endpoint.
    base_url: str | None
    #: The config attribute holding the server's own key for this provider.
    key_env: str
    key_prefix: str
    key_re: re.Pattern[str]
    keys_url: str
    #: Can embed documents for upload and document search.
    embeddings: bool
    #: Which hosted web search this vendor's own key can pay for, if any:
    #: "openai" (Responses web_search) or "groq" (gpt-oss browser_search).
    hosted_search: str | None
    #: Has hosted speech-to-text on the OpenAI transcription protocol.
    transcription: bool


OPENAI = Provider(
    id="openai", label="OpenAI", base_url=None, key_env="OPENAI_API_KEY",
    key_prefix="sk-", key_re=re.compile(r"^sk-[A-Za-z0-9_\-]{16,250}$"),
    keys_url="https://platform.openai.com/api-keys",
    embeddings=True, hosted_search="openai", transcription=True,
)
XAI = Provider(
    id="xai", label="xAI (Grok)", base_url=config.XAI_BASE_URL, key_env="XAI_API_KEY",
    key_prefix="xai-", key_re=re.compile(r"^xai-[A-Za-z0-9_\-]{16,250}$"),
    keys_url="https://console.x.ai",
    embeddings=False, hosted_search=None, transcription=False,
)
GROQ = Provider(
    id="groq", label="Groq", base_url=config.GROQ_BASE_URL, key_env="GROQ_API_KEY",
    key_prefix="gsk_", key_re=re.compile(r"^gsk_[A-Za-z0-9]{16,250}$"),
    keys_url="https://console.groq.com/keys",
    embeddings=False, hosted_search="groq", transcription=True,
)

PROVIDERS: dict[str, Provider] = {p.id: p for p in (OPENAI, XAI, GROQ)}

#: Anything shaped like a key from any provider, for scrubbing text we did not
#: construct ourselves.
ANY_KEY_RE = re.compile(r"(sk-|xai-|gsk_)[A-Za-z0-9_\-]{16,250}")


def for_key(key: str) -> Provider | None:
    """The provider a well-formed key belongs to, or None for anything else."""
    for p in PROVIDERS.values():
        if p.key_re.match(key):
            return p
    return None


def server() -> Provider:
    """The provider the server's own key belongs to (`PROVIDER`)."""
    p = PROVIDERS.get(config.PROVIDER)
    if p is None:
        log.warning("unknown PROVIDER=%r — using openai", config.PROVIDER)
        return OPENAI
    return p


def server_key(p: Provider) -> str | None:
    return getattr(config, p.key_env, None)


@dataclass(frozen=True)
class Models:
    """One provider's model for each role the app has."""

    default: str
    voice: str
    quick_voice: str
    instant: str
    deep: str
    thinking: str
    #: The allowlist a client-supplied model id is checked against.
    chat: list[str]


def models(p: Provider) -> Models:
    # Read at call time rather than captured at import, so the settings stay
    # overridable the same way every other config value is.
    if p is OPENAI:
        return Models(
            default=config.OPENAI_MODEL, voice=config.VOICE_MODEL,
            quick_voice=config.QUICK_VOICE_MODEL, instant=config.INSTANT_MODEL,
            deep=config.DEEP_MODEL, thinking=config.THINKING_MODEL, chat=config.CHAT_MODELS,
        )
    pre = p.id.upper()

    def get(name: str) -> Any:
        return getattr(config, f"{pre}_{name}")

    return Models(
        default=get("MODEL"), voice=get("VOICE_MODEL"), quick_voice=get("QUICK_VOICE_MODEL"),
        instant=get("INSTANT_MODEL"), deep=get("DEEP_MODEL"), thinking=get("THINKING_MODEL"),
        chat=get("CHAT_MODELS"),
    )


def transcribe_model(p: Provider) -> str | None:
    if p is OPENAI:
        return config.TRANSCRIBE_MODEL
    if p is GROQ:
        return config.GROQ_TRANSCRIBE_MODEL
    return None


# ── Reasoning parameters ────────────────────────────────────────────────────
# Each vendor splits its models differently, and sending a parameter a model
# does not take is a hard 400 — so these are per provider, decided by model id.
_OPENAI_REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def is_reasoning_model(p: Provider, model: str) -> bool:
    m = model.lower()
    if p is OPENAI:
        return m.startswith(_OPENAI_REASONING_PREFIXES)
    if p is XAI:
        # Every current Grok reasons except the explicitly `-non-reasoning` ids.
        return "non-reasoning" not in m
    if p is GROQ:
        return m.startswith("openai/gpt-oss")
    return False


#: Grok models documented to take `reasoning_effort` (low | medium | high).
_XAI_EFFORT_PREFIXES = ("grok-4.5", "grok-4.6", "grok-4.7")


def sampling_options(p: Provider, model: str, effort: str | None) -> dict[str, Any]:
    """The temperature / reasoning-effort parameters `model` actually accepts."""
    if not is_reasoning_model(p, model):
        return {"temperature": 0.5}
    m = model.lower()
    if p is XAI:
        # An unrequested effort means an ordinary turn, where latency matters
        # more than depth — so "low", not the vendor's own default of "high".
        if m.startswith(_XAI_EFFORT_PREFIXES):
            return {"reasoning_effort": effort or "low"}
        # grok-3-mini takes low or high only.
        if m.startswith("grok-3-mini"):
            return {"reasoning_effort": "low" if effort == "low" else "high"}
        # Other Grok reasoners don't document the parameter; send nothing.
        return {}
    if p is GROQ:
        # gpt-oss is the only production family, so it serves voice too: keep
        # unrequested effort low. Thinking mode passes its own.
        return {"reasoning_effort": effort or "low"}
    # OpenAI's o-series / gpt-5 take low | medium | high.
    return {"reasoning_effort": effort or "medium"}
