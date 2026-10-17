"""Nexus — LangChain + Qdrant RAG + Conversational AI backend."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
 
from . import agent, config, conversations, identity, providers, stt, suggest as suggest_api
from .auth import Principal, get_principal, principal_for_ws, probe_supabase, require_principal
from .credentials import (
    Credentials,
    get_credentials,
    redact,
    require_usable,
    requested_provider,
)
from .context_builder import (
    build_agent_system_prompt,
    build_instant_system_prompt,
    build_quick_voice_system_prompt,
)
from .vectorstore import DocumentStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("universalcb.main")

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Prime the voice models' connections in the background, so the cost of the
    first handshake isn't charged to the user's first spoken turn."""
    server_provider = providers.server()
    if config.WARM_MODELS_ON_START and providers.server_key(server_provider):
        voice = providers.models(server_provider)
        asyncio.create_task(
            agent.warm_models([voice.quick_voice, voice.voice], server_provider)
        )
    # Same argument for the local transcriber, but the stakes are higher: the
    # first call downloads ~800 MB of weights, and charging that to whoever
    # happens to speak first means a voice turn that appears to hang.
    asyncio.create_task(stt.warmup_local_model())
    # Surface auth misconfiguration at boot rather than on someone's first
    # sign-in attempt.
    probe = await probe_supabase()
    if probe.get("configured"):
        log.info("supabase auth: %s", probe)
    else:
        log.info("supabase auth: not configured — all callers are anonymous")
    yield


app = FastAPI(title="Nexus", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    # Required for the anonymous identity cookie to travel: the frontend is on
    # :5173 and the API on :8001, so every request is cross-origin. Note this is
    # only safe because allow_origins is an explicit allowlist — the browser
    # refuses credentialed requests against a "*" origin.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialise the Qdrant-backed store. If creds/connection fail, keep general
# chat available in degraded mode; only document operations require the store.
store: DocumentStore | None = None
STORE_ERROR: str | None = None
try:
    store = DocumentStore()
except Exception as e:  # noqa: BLE001
    STORE_ERROR = str(e)
    log.error("DocumentStore init failed: %s", e)


# ── Schemas ──────────────────────────────────────────────────────────────────
class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    # Accepted for backward compatibility but IGNORED for scoping — ownership
    # comes from the verified Principal. Keeping the field lets older clients
    # keep working instead of failing validation.
    session_id: str = ""
    conversation_history: list[Message] = Field(default_factory=list)
    stream: bool = False
    bot_name: str | None = None
    from_voice: bool = False
    doc_ids: list[str] | None = None
    reply_language: str | None = None
    # Which composer chip the user sent this from. Unknown values are rejected
    # by pydantic rather than silently falling through to an expensive profile.
    mode: Literal["instant", "web", "deep"] = "web"
    thinking: bool = False
    # Advisory: honoured only if it is in the provider's chat-model allowlist.
    model: str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────
async def _prepare(req: ChatRequest, owner: str, quick_voice: bool = False) -> tuple[list, str]:
    if quick_voice:
        # A greeting never consults documents, so listing them would only be
        # thrown away — and that Qdrant Cloud round-trip sits directly in front
        # of time-to-first-token on exactly the turns that must feel instant.
        system_prompt = build_quick_voice_system_prompt(req.bot_name, req.reply_language)
    elif req.mode == "instant" and not req.from_voice:
        # No tools here, so there is nothing to list documents for — and that
        # Qdrant round-trip would sit directly in front of the one mode judged
        # purely on speed.
        system_prompt = build_instant_system_prompt(req.bot_name, req.reply_language)
    else:
        doc_names = await store.doc_names(owner) if store else []
        system_prompt = build_agent_system_prompt(
            bot_name=req.bot_name, doc_names=doc_names, from_voice=req.from_voice,
            reply_language=req.reply_language,
            mode="web" if req.from_voice else req.mode,
        )
    history = [m.model_dump() for m in req.conversation_history]
    messages = agent.to_lc_messages(history, req.message)
    return messages, system_prompt


def _ndjson(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


def _upstream_error(e: Exception, provider: providers.Provider) -> str:
    """What to tell the user when the provider refused the request.

    The raw text ("Error code: 401 - {'error': {'message': 'Invalid API Key'…")
    is accurate but unreadable, and the commonest causes are ones the user fixes
    in settings — so those get a sentence that says which. Everything else keeps
    the raw text, redacted: an upstream auth failure can quote the key it
    rejected, and with BYOK that key belongs to the user, not to us.
    """
    status = getattr(e, "status_code", None)
    name = provider.label
    if status == 401:
        return (
            f"{name} rejected your API key. It may be mistyped, revoked, or from a "
            "different account. Update it under API key in the sidebar."
        )
    if status == 403:
        return f"Your {name} key doesn't have access to this model. Check the key's permissions with {name}."
    if status == 429:
        return (
            f"{name} is rate-limiting this key, or it has run out of credit. Wait a moment, "
            f"or check your usage and billing with {name}."
        )
    if status == 404:
        # The provider's own message names the model, which is the one fact the
        # operator needs to fix this — so it is passed through, redacted.
        body = getattr(e, "body", None)
        detail = body.get("message") if isinstance(body, dict) else None
        suffix = f" ({redact(str(detail))})" if detail else ""
        return (
            f"{name} doesn't recognise the model this request asked for{suffix}. Its model "
            "names may have changed; the server's model settings need updating."
        )
    return redact(str(e))


def _agent_profile(
    req: ChatRequest, provider: providers.Provider, quick_voice: bool = False,
) -> dict:
    """Model + budget for this turn on `provider`, resolved from the search mode.

    Voice keeps its own latency-tuned profile and ignores the composer chips —
    a spoken turn has no UI to pick them from.
    """
    models = providers.models(provider)
    if req.from_voice:
        profile = {"model": models.quick_voice if quick_voice else models.voice}
        # A spoken exchange cannot absorb five tool rounds of dead air the way a
        # text one can. Two rounds covers search-then-refine; past that the
        # agent's budget-exhaustion path synthesizes from what it has.
        if not quick_voice:
            profile["max_iterations"] = 2
        if config.VOICE_REASONING_EFFORT:
            profile["reasoning_effort"] = config.VOICE_REASONING_EFFORT
        return profile

    if req.mode == "instant":
        model, max_iterations = models.instant, 1
    elif req.mode == "deep":
        model, max_iterations = models.deep, config.DEEP_MAX_ITERATIONS
    else:
        model, max_iterations = models.default, 5

    # An explicit pick overrides the mode's default model but not its budget:
    # choosing a model shouldn't silently buy more tool rounds.
    if req.model:
        if req.model in models.chat:
            model = req.model
        else:
            log.warning("ignoring model %r — not in %s's allowlist", req.model, provider.id)

    profile: dict = {"model": model, "max_iterations": max_iterations}
    if req.thinking:
        # Only a reasoning model can actually think; anything else is swapped
        # out rather than sent a parameter it will reject.
        if not providers.is_reasoning_model(provider, model):
            profile["model"] = models.thinking
        profile["reasoning_effort"] = config.THINKING_EFFORT
    return profile


def _tools_for(
    req: ChatRequest, owner: str, sources: list[dict], quick_voice: bool,
    creds: Credentials,
) -> list:
    """Instant mode answers from the model alone — no retrieval, no web hop.
    That, not the smaller model, is what makes it feel instant."""
    if quick_voice or (not req.from_voice and req.mode == "instant"):
        return []
    return agent.build_tools(
        owner, store, sources, doc_ids=req.doc_ids,
        api_key=creds.api_key, provider=creds.provider,
    )


_CASUAL_VOICE_RE = re.compile(
    r"^(?:(?:hi|hello|hey)(?: (?:there|nova|nexus|assistant))?(?: how are you)?|"
    r"how are you|how is it going|what(?:'s| is) up|who are you|"
    r"what(?:'s| is) your name|thanks|thank you|bye|goodbye)$",
    re.IGNORECASE,
)


def _is_quick_voice_turn(req: ChatRequest) -> bool:
    if not req.from_voice:
        return False
    normalized = re.sub(r"[^\w'\s]", " ", req.message).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    return bool(_CASUAL_VOICE_RE.fullmatch(normalized))


def _require_store() -> DocumentStore:
    if store is None:
        raise HTTPException(
            status_code=503,
            detail=f"Document search is unavailable: {STORE_ERROR or 'vector database not configured'}",
        )
    return store


# ── Routes ───────────────────────────────────────────────────────────────────
@app.get("/health")
async def health(principal: Principal = Depends(get_principal)) -> dict:
    server_provider = providers.server()
    return {
        "status": "ok" if store else "degraded",
        "chat_ok": True,
        "provider": server_provider.id,
        "vector_db": "qdrant" if store else "unavailable",
        "qdrant_ok": bool(store and store.ping()),
        "error": STORE_ERROR,
        "auth": {
            "supabase_configured": bool(config.SUPABASE_URL),
            # Never the id itself — just whether this caller is signed in.
            "authenticated": principal.is_authenticated,
            "required": config.REQUIRE_AUTH,
        },
        # What this deployment expects of the caller, so the UI can prompt for it
        # up front instead of discovering it through a failed request.
        "byok": {
            "accepted": config.ALLOW_USER_API_KEYS,
            "required": config.REQUIRE_USER_API_KEY,
            # Whether a key is only honoured from a signed-in account. The client
            # reads this to order its prompts: asking a stranger for a
            # credential before they have an account is the one sequence we
            # never want, and this is what tells the UI so.
            "requires_auth": config.REQUIRE_AUTH_FOR_USER_KEY,
            # Whether the server could answer with its own key if none is given.
            "server_key_available": bool(providers.server_key(server_provider)),
        },
        "stt_backend": config.STT_BACKEND,
        # Which transcriber is actually loaded. `loaded` stays null until the
        # weights are in memory, and can differ from `configured` when the
        # machine could not hold the requested tier — a silent downgrade is
        # exactly the kind of thing that should be visible somewhere.
        "stt_local": stt.local_model_status(),
    }


@app.get("/suggest")
async def suggest(q: str = "", lang: str = "en", _: Principal = Depends(get_principal)) -> dict:
    """Query autocomplete for the composer. Relayed rather than called from the
    browser because the upstream endpoints send no CORS headers."""
    return {"suggestions": await suggest_api.suggest(q, lang)}


@app.get("/models")
async def models(request: Request, _: Principal = Depends(get_principal)) -> dict:
    """The picker's options for the provider this caller's key belongs to.
    Served rather than hardcoded in the client so that editing the allowlist in
    .env is enough to change what users can select."""
    provider = requested_provider(request)
    available = providers.models(provider)
    return {
        "provider": provider.id,
        "models": available.chat,
        "default": available.default,
        "thinking_model": available.thinking,
    }


def _canned_stream(text: str):
    """Emit a fixed answer in the same NDJSON shape the agent produces, so the
    client can't tell the difference and TTS still streams it normally."""
    async def gen():
        yield _ndjson({"type": "delta", "text": text})
        yield _ndjson({"type": "done"})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.post("/chat")
async def chat(
    req: ChatRequest,
    principal: Principal = Depends(require_principal),
    creds: Credentials = Depends(get_credentials),
):
    # Identity questions are answered from our own definition, not the model's
    # pretraining — deterministic, instant, and immune to drift between turns.
    # Answered before any credential check: it costs nothing to serve.
    canned = identity.match_identity_intent(req.message)
    if canned:
        log.info("identity fast-path: %r", req.message[:60])
        if req.stream:
            return _canned_stream(canned)
        return {"reply": canned, "sources": []}

    api_key = require_usable(creds)
    owner = principal.owner_key
    quick_voice = _is_quick_voice_turn(req)
    messages, system_prompt = await _prepare(req, owner, quick_voice)
    sources: list[dict] = []
    tools = _tools_for(req, owner, sources, quick_voice, creds)
    profile = {
        **_agent_profile(req, creds.provider, quick_voice),
        "api_key": api_key,
        "provider": creds.provider,
    }

    if req.stream:
        async def gen():
            # Which model is answering, first — so the UI can label the turn with
            # what actually ran rather than a guess.
            yield _ndjson({"type": "meta", "model": profile["model"], "provider": creds.provider.id})
            try:
                async for ev in agent.agent_stream(messages, system_prompt, tools, **profile):
                    yield _ndjson(ev)
                if sources:
                    yield _ndjson({"type": "sources", "items": sources})
                yield _ndjson({"type": "done"})
            except Exception as e:  # noqa: BLE001
                log.exception("agent_stream failed")
                yield _ndjson({"type": "error", "message": _upstream_error(e, creds.provider)})

        return StreamingResponse(gen(), media_type="application/x-ndjson")

    try:
        chunks: list[str] = []
        async for ev in agent.agent_stream(messages, system_prompt, tools, **profile):
            if ev.get("type") == "delta":
                chunks.append(ev["text"])
        return {
            "reply": "".join(chunks), "sources": sources,
            "model": profile["model"], "provider": creds.provider.id,
        }
    except Exception as e:  # noqa: BLE001
        log.exception("agent run failed")
        return {"error": _upstream_error(e, creds.provider)}


@app.post("/upload")
async def upload(
    files: list[UploadFile] = File(...),
    principal: Principal = Depends(require_principal),
    creds: Credentials = Depends(get_credentials),
):
    document_store = _require_store()
    # Ingesting a file means embedding every chunk of it, and that is a paid
    # OpenAI call. Resolving the key here means the caller is told to add one
    # (402) before we read a single byte — and, on a public deployment, that
    # the bill for a stranger's 25MB PDF lands on the stranger.
    api_key = require_usable(creds)
    if not creds.provider.embeddings:
        # Refused rather than embedded on the server's OpenAI key: the caller
        # chose to pay for their own usage, and this would quietly bill ours.
        raise HTTPException(
            status_code=400,
            detail=(
                f"Uploading documents needs an OpenAI key — {creds.provider.label} "
                "can't create the embeddings document search runs on. Chat, web "
                "search and voice work with your current key."
            ),
        )
    owner = principal.owner_key
    max_bytes = config.MAX_UPLOAD_MB * 1024 * 1024
    results: list[dict] = []
    for f in files:
        data = await f.read()
        name = f.filename or "untitled"
        if len(data) > max_bytes:
            results.append({"name": name, "status": "error",
                            "error": f"File exceeds the {config.MAX_UPLOAD_MB}MB limit.", "n_chunks": 0})
            continue
        results.append(await document_store.add(owner, name, data, api_key))
    return {"documents": results}


# No id in the path: you can only ever list or delete your own documents, so
# there is nothing for an attacker to enumerate or substitute.
@app.get("/documents")
async def list_documents(principal: Principal = Depends(require_principal)) -> dict:
    if store is None:
        return {"documents": []}
    return {"documents": await store.list(principal.owner_key)}


@app.delete("/documents/{doc_id}")
async def delete_document(doc_id: str, principal: Principal = Depends(require_principal)) -> dict:
    if store is None:
        return {"deleted": False}
    return {"deleted": await store.delete(principal.owner_key, doc_id)}


# ── Conversation history ─────────────────────────────────────────────────────
# Like /documents, none of these take an owner: the row key is (owner_key, id)
# and owner_key comes from the verified principal, so there is nothing for a
# caller to substitute. A conversation id from another account simply does not
# match any row.
#
# Every route degrades to an empty answer rather than an error when sync is
# unconfigured, so the client keeps working from its local cache.
@app.get("/conversations")
async def list_conversations(principal: Principal = Depends(require_principal)) -> dict:
    return {
        "conversations": await conversations.list_meta(principal.owner_key),
        "synced": conversations.available(),
    }


@app.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str, principal: Principal = Depends(require_principal),
) -> dict:
    found = await conversations.get(principal.owner_key, conversation_id)
    if found is None:
        raise HTTPException(status_code=404, detail="No such conversation.")
    return found


class ConversationBody(BaseModel):
    title: str = "New chat"
    messages: list[dict] = []


@app.put("/conversations/{conversation_id}")
async def put_conversation(
    conversation_id: str,
    body: ConversationBody,
    principal: Principal = Depends(require_principal),
) -> dict:
    ok = await conversations.upsert(
        principal.owner_key, conversation_id, body.title, body.messages,
    )
    return {"saved": ok}


@app.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str, principal: Principal = Depends(require_principal),
) -> dict:
    return {"deleted": await conversations.delete(principal.owner_key, conversation_id)}


@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    session_id: str = Form(""),  # ignored; kept so older clients still post
    prompt: str = Form(""),
    language: str = Form(""),
    # This route had no identity check at all, so anyone who could reach the
    # server could spend its transcription budget by posting audio at it.
    _: Principal = Depends(require_principal),
    creds: Credentials = Depends(get_credentials),
):
    try:
        content = await file.read()
        text = await stt.transcribe(
            content, file.filename or "audio.webm", prompt, language,
            creds.api_key, creds.provider,
        )
        # Session/owner ids are deliberately absent: anyone with log access could
        # otherwise replay one and read the corresponding documents.
        log.info("transcribe backend=%s lang=%s len=%d -> %r",
                 config.STT_BACKEND, language, len(content), text[:120])
        return {"text": text, "backend": config.STT_BACKEND}
    except Exception as e:  # noqa: BLE001
        log.exception("transcribe failed")
        return {"error": redact(str(e))}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    # Same rule as HTTP: identity from the cookie or a verified token, never
    # from the URL. `?token=` is used because browsers can't set WebSocket
    # headers; the cookie still travels automatically on same-site connections.
    principal = await principal_for_ws(
        dict(websocket.cookies), websocket.query_params.get("token")
    )
    if config.REQUIRE_AUTH and not principal.is_authenticated:
        # 1008 = policy violation. Closing beats accepting turns we will refuse.
        await websocket.send_json({"type": "error", "message": "Sign in to continue."})
        await websocket.close(code=1008)
        return
    owner = principal.owner_key
    # Browsers cannot set WebSocket headers, so a BYOK key can only arrive in the
    # query string — which lands in server and proxy access logs. Rather than
    # leak it there, this transport simply does not support BYOK: it falls back
    # to the server key, and is refused outright when there isn't one.
    ws_provider = providers.server()
    ws_key = providers.server_key(ws_provider)
    ws_creds = Credentials(api_key=ws_key, provider=ws_provider, user_supplied=False)
    if config.REQUIRE_USER_API_KEY or not ws_key:
        await websocket.send_json({
            "type": "error",
            "message": "This deployment requires your own API key; use the HTTP endpoint.",
        })
        await websocket.close(code=1008)
        return
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "invalid json"})
                continue
            try:
                req = ChatRequest(
                    message=payload.get("message", ""),
                    conversation_history=[Message(**m) for m in payload.get("conversation_history", [])],
                    bot_name=payload.get("bot_name"),
                    from_voice=bool(payload.get("from_voice", False)),
                    doc_ids=payload.get("doc_ids"),
                    reply_language=payload.get("reply_language"),
                )
            except Exception as e:  # noqa: BLE001
                await websocket.send_json({"type": "error", "message": f"bad payload: {e}"})
                continue

            canned = identity.match_identity_intent(req.message)
            if canned:
                await websocket.send_json({"type": "start"})
                await websocket.send_json({"type": "delta", "text": canned})
                await websocket.send_json({"type": "done"})
                continue

            quick_voice = _is_quick_voice_turn(req)
            messages, system_prompt = await _prepare(req, owner, quick_voice)
            sources: list[dict] = []
            tools = _tools_for(req, owner, sources, quick_voice, ws_creds)
            ws_profile = _agent_profile(req, ws_provider, quick_voice)
            await websocket.send_json({"type": "start"})
            await websocket.send_json({"type": "meta", "model": ws_profile["model"], "provider": ws_provider.id})
            try:
                async for ev in agent.agent_stream(
                    messages, system_prompt, tools, **ws_profile,
                    api_key=ws_key, provider=ws_provider,
                ):
                    await websocket.send_json(ev)
                if sources:
                    await websocket.send_json({"type": "sources", "items": sources})
                await websocket.send_json({"type": "done"})
            except Exception as e:  # noqa: BLE001
                await websocket.send_json({"type": "error", "message": _upstream_error(e, ws_provider)})
    except WebSocketDisconnect:
        # Never log the owner key — it's a bearer-equivalent secret for anons.
        log.info("ws disconnected (%s)", principal.kind)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host=config.HOST, port=config.PORT, reload=True)
