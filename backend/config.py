"""Centralised settings loaded from environment / backend/.env."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env explicitly so the server works no matter the CWD.
_ENV_PATH = Path(__file__).parent / ".env"
if _ENV_PATH.exists():
    load_dotenv(_ENV_PATH)
else: 
    # Fallback to default discovery (root .env, or environment-only).
    load_dotenv()


def _bool(v: str | None, default: bool = False) -> bool:
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


# Which provider the SERVER's own key belongs to: openai | xai | groq. A caller
# who brings their own key is routed by that key's prefix instead — see
# providers.py. The model settings below are OpenAI's; xAI and Groq have their
# own set further down.
PROVIDER: str = os.getenv("PROVIDER", "openai").strip().lower()

OPENAI_API_KEY: str | None = os.getenv("OPENAI_API_KEY")
ANTHROPIC_API_KEY: str | None = os.getenv("ANTHROPIC_API_KEY")

OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-4o")
# Voice turns prioritize time-to-first-token while keeping function calling for
# document/web tools. Text turns continue to use OPENAI_MODEL for full quality.
VOICE_MODEL: str = os.getenv("VOICE_MODEL", "gpt-4.1-mini")
# Trivial greetings do not need tools or heavier reasoning.
QUICK_VOICE_MODEL: str = os.getenv("QUICK_VOICE_MODEL", "gpt-4.1-nano")
VOICE_REASONING_EFFORT: str = os.getenv("VOICE_REASONING_EFFORT", "").strip()
# Send a 1-token request to the voice models at startup so the first spoken turn
# doesn't pay for DNS + the TLS handshake. Costs a fraction of a cent per boot;
# set to "false" if you restart the server constantly.
WARM_MODELS_ON_START: bool = os.getenv("WARM_MODELS_ON_START", "true").lower() == "true"

# ── Search modes ─────────────────────────────────────────────────────────────
# The composer's three chips map onto three agent profiles. Only the model and
# the tool/iteration budget differ — the agent loop itself is shared.
#
# Instant: no tools at all, one pass, smallest model. Answers from the model's
# own knowledge, so it returns in well under a second and costs almost nothing.
INSTANT_MODEL: str = os.getenv("INSTANT_MODEL", "gpt-4.1-nano")
# Deep research: more tool rounds so the agent can search, read, and re-search.
# This is a single wider agent pass, NOT the multi-agent pipeline — that needs a
# real search API and a background job runner before it's worth building.
DEEP_MODEL: str = os.getenv("DEEP_MODEL", OPENAI_MODEL)
DEEP_MAX_ITERATIONS: int = int(os.getenv("DEEP_MAX_ITERATIONS", "8"))
# Thinking mode. `reasoning_effort` is only accepted by reasoning models — the
# chat models (gpt-4o, gpt-4.1-*) reject it — so toggling Thinking on a chat
# model swaps to this one. Override only with another reasoning model.
THINKING_MODEL: str = os.getenv("THINKING_MODEL", "o4-mini")
THINKING_EFFORT: str = os.getenv("THINKING_EFFORT", "medium")

# Models the client is allowed to ask for by id. A client-supplied model string
# is spend someone else authorises, so it is matched against this list and
# ignored when absent — never forwarded to the API as-is.
CHAT_MODELS: list[str] = [
    m.strip() for m in os.getenv(
        "CHAT_MODELS", "gpt-4o,gpt-4o-mini,gpt-4.1,gpt-4.1-mini,gpt-4.1-nano,o4-mini",
    ).split(",") if m.strip()
]


def _list(name: str, default: str) -> list[str]:
    return [m.strip() for m in os.getenv(name, default).split(",") if m.strip()]


# ── Other OpenAI-compatible providers ───────────────────────────────────────
# Same roles as the OpenAI settings above, one set per provider. Model ids are
# the vendor's and change often, so they live here rather than in code. Last
# checked against both providers' model pages on 2026-10-17; when a provider
# retires one, the chat error names the model it no longer recognises.
#
# xAI (Grok). Keys start with `xai-`. The grok-4.5+ family always reasons
# (effort low|medium|high, default high); `-non-reasoning` is the fast lane.
XAI_API_KEY: str | None = os.getenv("XAI_API_KEY")
XAI_BASE_URL: str = os.getenv("XAI_BASE_URL", "https://api.x.ai/v1")
XAI_MODEL: str = os.getenv("XAI_MODEL", "grok-4.20-0309-non-reasoning")
XAI_VOICE_MODEL: str = os.getenv("XAI_VOICE_MODEL", "grok-4.20-0309-non-reasoning")
XAI_QUICK_VOICE_MODEL: str = os.getenv("XAI_QUICK_VOICE_MODEL", "grok-4.20-0309-non-reasoning")
XAI_INSTANT_MODEL: str = os.getenv("XAI_INSTANT_MODEL", "grok-4.20-0309-non-reasoning")
XAI_DEEP_MODEL: str = os.getenv("XAI_DEEP_MODEL", "grok-4.7")
XAI_THINKING_MODEL: str = os.getenv("XAI_THINKING_MODEL", "grok-4.7")
XAI_CHAT_MODELS: list[str] = _list(
    "XAI_CHAT_MODELS",
    "grok-4.7,grok-4.6,grok-4.5,grok-4.3,grok-4.20-0309-reasoning,grok-4.20-0309-non-reasoning",
)

# Groq (fast inference on open-weight models). Keys start with `gsk_`. Groq also
# hosts Whisper, so a Groq key covers hosted transcription as well. Its Llama
# models were retired for non-enterprise accounts on 2026-08-16; gpt-oss is
# the current production pair, and both are reasoning models.
GROQ_API_KEY: str | None = os.getenv("GROQ_API_KEY")
GROQ_BASE_URL: str = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_MODEL: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_VOICE_MODEL: str = os.getenv("GROQ_VOICE_MODEL", "openai/gpt-oss-20b")
GROQ_QUICK_VOICE_MODEL: str = os.getenv("GROQ_QUICK_VOICE_MODEL", "openai/gpt-oss-20b")
GROQ_INSTANT_MODEL: str = os.getenv("GROQ_INSTANT_MODEL", "openai/gpt-oss-20b")
GROQ_DEEP_MODEL: str = os.getenv("GROQ_DEEP_MODEL", "openai/gpt-oss-120b")
GROQ_THINKING_MODEL: str = os.getenv("GROQ_THINKING_MODEL", "openai/gpt-oss-120b")
GROQ_CHAT_MODELS: list[str] = _list("GROQ_CHAT_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b")
GROQ_TRANSCRIBE_MODEL: str = os.getenv("GROQ_TRANSCRIBE_MODEL", "whisper-large-v3-turbo")

# ── Supabase auth (optional) ────────────────────────────────────────────────
# With SUPABASE_URL unset the app still runs; every caller is simply anonymous,
# scoped by a server-issued httpOnly cookie instead of a user account.
SUPABASE_URL: str = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
# Only needed for legacy projects that sign tokens with a shared HS256 secret;
# projects using asymmetric signing keys are verified via JWKS with no secret.
SUPABASE_JWT_SECRET: str = os.getenv("SUPABASE_JWT_SECRET", "").strip()
# Server-side Postgres access, used by conversations.py to sync chat history
# across a user's devices. This key BYPASSES row-level security, which is the
# whole reason the `conversations` table has no RLS policies — the backend is
# the only thing allowed to touch it, and it scopes every query by the verified
# `Principal.owner_key`. Never expose it to the client.
#
# Leave unset and the app still works: history simply stays in the browser's
# local storage, as it did before sync existed.
SUPABASE_SERVICE_ROLE_KEY: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
# Set false only for plain-HTTP local dev; browsers reject Secure cookies there.
COOKIE_SECURE: bool = os.getenv("COOKIE_SECURE", "false").lower() == "true"

# Require a signed-in account for the routes that spend money or touch stored
# data. Defaults to ON exactly when Supabase is configured: if you have wired up
# sign-in, anonymous spend is almost certainly not what you want — and if you
# have not, defaulting this on would lock every user out of a working app with
# no way in. Override explicitly to force either behaviour.
REQUIRE_AUTH: bool = _bool(os.getenv("REQUIRE_AUTH"), bool(SUPABASE_URL))

# ── BYOK: bring your own key ────────────────────────────────────────────────
# Accept an OpenAI, xAI or Groq key supplied by the caller, used for that
# request only and never stored or logged. See credentials.py for the guarantees.
ALLOW_USER_API_KEYS: bool = _bool(os.getenv("ALLOW_USER_API_KEYS"), True)
# Refuse to fall back to the server's own key, so the deployment cannot spend
# the operator's credit on other people's questions. Turn this on for any
# instance that is reachable by people you do not personally know.
REQUIRE_USER_API_KEY: bool = _bool(os.getenv("REQUIRE_USER_API_KEY"), False)
# Accept a caller-supplied key only from a signed-in account.
#
# Not a formality. A key arriving from an unidentified browser is a credential
# we can attribute to nobody: if it is spent oddly there is no account to warn,
# no session to revoke and no way to tell one anonymous caller from the next. It
# is also the shape of the attack the feature invites — "paste your API key" in
# front of a stranger who has no way to know whose page they are on. Requiring
# an account first means the person pasting a key has already established who
# they are, and every request that spends it is attributable to them.
REQUIRE_AUTH_FOR_USER_KEY: bool = _bool(os.getenv("REQUIRE_AUTH_FOR_USER_KEY"), True)

# Product identity — what the assistant says when asked who/what it is. See
# identity.py; these feed both the system prompt and the deterministic answers.
PRODUCT_NAME: str = os.getenv("PRODUCT_NAME", "Nexus")
ORG_NAME: str = os.getenv("ORG_NAME", "the Nexus team")
PRODUCT_SUMMARY: str = os.getenv(
    "PRODUCT_SUMMARY",
    "an AI research assistant that answers from your uploaded documents and "
    "live web search, with sources behind every answer",
)
CLAUDE_MODEL: str = os.getenv("CLAUDE_MODEL", "claude-opus-4-7")
TRANSCRIBE_MODEL: str = os.getenv("TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")

# RAG settings
RAG_TOP_K: int = int(os.getenv("RAG_TOP_K", "6"))
CHUNK_TOKENS: int = int(os.getenv("CHUNK_TOKENS", "800"))
CHUNK_OVERLAP_TOKENS: int = int(os.getenv("CHUNK_OVERLAP_TOKENS", "120"))
# Per-file upload cap (MB). Generous default for typical PDFs/reports.
MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "25"))
# Embedding vector size — text-embedding-3-small = 1536.
EMBEDDING_DIM: int = int(os.getenv("EMBEDDING_DIM", "1536"))

# Qdrant Cloud vector DB
QDRANT_URL: str | None = os.getenv("QDRANT_URL")
QDRANT_API_KEY: str | None = os.getenv("QDRANT_API_KEY")
QDRANT_COLLECTION: str = os.getenv("QDRANT_COLLECTION", "nexus_documents")

# STT backend: "local" (faster-whisper, free, runs on this machine) or "openai"
# (hosted, paid). Defaults to local so the whole voice path is free: VAD (Silero,
# in-browser), TTS (OS voices) and primary STT (Web Speech) already cost nothing,
# and this fallback transcription was the last step that billed. First use
# downloads the model weights, and CPU transcription is slower than hosted —
# set STT_BACKEND=openai if you would rather pay for the latency.
STT_BACKEND: str = os.getenv("STT_BACKEND", "local").lower()
# Whether this server may run Whisper itself when hosted transcription is
# unavailable (the user's key is rate-limited or out of credit, their provider
# has none — xAI — or the provider is down). On by default only when local is
# the configured backend. On a hosted deployment the server's own CPU would be
# paying for the user's quota — on Cloud Run that is ~3s a clip on one vCPU plus
# a model download per new instance — so it says "unavailable" at once instead,
# and the browser's own transcript is used for that turn.
LOCAL_STT_FALLBACK: bool = _bool(os.getenv("LOCAL_STT_FALLBACK"), STT_BACKEND == "local")
# faster-whisper model when STT_BACKEND=local. "auto" picks from the device —
# see stt._configured_model for the reasoning and the measurements behind it.
#
# Transcription accuracy is the ceiling on how well the assistant can answer: a
# word Whisper guesses wrong is a word the model then reasons from. Across the
# family, error runs from roughly 13% (tiny) to ~3.5% (large-v3), with
# `large-v3-turbo` at ~3.7% — so the temptation is to always take the biggest
# one. On a CPU that is a trap, and the ladder below exists because of it.
LOCAL_WHISPER_MODEL: str = os.getenv("LOCAL_WHISPER_MODEL", "auto")
LOCAL_WHISPER_DEVICE: str = os.getenv("LOCAL_WHISPER_DEVICE", "cpu")  # or "cuda"
LOCAL_WHISPER_COMPUTE: str = os.getenv("LOCAL_WHISPER_COMPUTE", "int8")  # int8 / float16 / float32
# Worker threads for CPU decoding. 0 leaves the choice to ctranslate2, which
# reads the machine rather than guessing from here.
LOCAL_WHISPER_CPU_THREADS: int = int(os.getenv("LOCAL_WHISPER_CPU_THREADS", "0"))
# Beam width. 5 is the faster-whisper default and a good accuracy/latency point;
# 1 (greedy) is materially quicker and materially worse.
LOCAL_WHISPER_BEAM_SIZE: int = int(os.getenv("LOCAL_WHISPER_BEAM_SIZE", "5"))
# If the configured model cannot be loaded — out of memory, download blocked,
# name not recognised — try progressively smaller ones instead of failing the
# voice turn. The substitution is logged loudly and reported on /health, because
# silently transcribing at a lower tier than requested is its own bug.
LOCAL_WHISPER_ALLOW_DOWNGRADE: bool = _bool(os.getenv("LOCAL_WHISPER_ALLOW_DOWNGRADE"), True)
# Load the weights at startup rather than on the first voice turn. Costs a slow
# boot once; the alternative is one user waiting through the download live.
LOCAL_WHISPER_WARMUP: bool = _bool(os.getenv("LOCAL_WHISPER_WARMUP"), True)

MAX_CONTEXT_TOKENS: int = int(os.getenv("MAX_CONTEXT_TOKENS", "8000"))
WEB_SEARCH_ENABLED: bool = _bool(os.getenv("WEB_SEARCH_ENABLED"), True)

# ── Web search ───────────────────────────────────────────────────────────────
# Which provider answers search_web, in order of how much the answer can be
# trusted. See web_search.py for the full reasoning; the short version is that
# the scraped tier returns confidently wrong results (a query about a person
# coming back with skincare listings) at HTTP 200, so it is a last resort and
# never a default.
#
#   openai  hosted web_search on the key already configured. Real citations.
#   tavily  a real search API. Needs TAVILY_API_KEY. Free tier available.
#   scrape  HTML scraping via ddgs. Free, no key, unreliable — see above.
#   auto    openai → tavily → scrape, first one that is usable.
WEB_SEARCH_PROVIDER: str = os.getenv("WEB_SEARCH_PROVIDER", "auto").strip().lower()
# Model used for the hosted-search call. Must be one that supports the
# web_search tool; the mini tier is enough since it only relays results.
WEB_SEARCH_MODEL: str = os.getenv("WEB_SEARCH_MODEL", "gpt-4o-mini")
# Groq's hosted search: gpt-oss with the built-in `browser_search` tool, paid by
# the caller's own Groq key (Groq bills it per search). OFF by default: it is a
# third gpt-oss call per search turn, with page content inside it, and Groq's
# free tier allows ~8K tokens a minute — a budget one search turn already
# nearly spends. Turn on when your users hold paid Groq keys; off, Groq users
# get the free scrape/Wikipedia tiers.
GROQ_BROWSER_SEARCH: bool = _bool(os.getenv("GROQ_BROWSER_SEARCH"), False)
GROQ_SEARCH_MODEL: str = os.getenv("GROQ_SEARCH_MODEL", "openai/gpt-oss-20b")
TAVILY_API_KEY: str = os.getenv("TAVILY_API_KEY", "").strip()
# Minimum share of a query's meaningful words that must appear in a scraped
# result for it to be citable. This is a safety net against a blocked scraper
# returning an unrelated page at 200 OK — not a relevance ranker, so it is tuned
# for recall: every real off-topic result observed in production scored exactly
# 0.0 (no shared term at all), while thin-but-genuine matches like "Musk's net
# worth" for "total revenue of Elon Musk" score 0.25. 0.2 separates those
# cleanly; raising it starts discarding real answers. 0 disables the check.
WEB_SEARCH_MIN_RELEVANCE: float = float(os.getenv("WEB_SEARCH_MIN_RELEVANCE", "0.2"))

HOST: str = os.getenv("HOST", "0.0.0.0")
PORT: int = int(os.getenv("PORT", "8000"))

# Comma-separated list of frontend origins allowed by CORS.
# Defaults cover Vite (5173) + the static-file dev server (5500).
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://localhost:5500,http://127.0.0.1:5173,http://127.0.0.1:5500",
    ).split(",") if o.strip()
]

MAX_HISTORY_TURNS: int = 10
INTERCEPT_BLOCKLIST = ("password", "token", "auth", "login", "secret", "credential")
