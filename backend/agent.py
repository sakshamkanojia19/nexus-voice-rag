"""LangChain-powered agentic chat: ChatOpenAI + bind_tools + a hand-managed
streaming loop that yields the same NDJSON dict events as before
({"type":"tool"|"delta"}). Tools wrap Qdrant document retrieval and web search,
appending [n] citations to a shared `sources` list.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, AsyncIterator

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI

from . import config, providers, web_search
from .providers import Provider
from .vectorstore import DocumentStore

log = logging.getLogger("universalcb.agent")

# ChatOpenAI is stateless across invocations and owns reusable HTTP clients.
# Cache one base instance per model profile to avoid a fresh connection setup
# on every spoken turn. Tools are still bound per request below.
#
# SECURITY: this cache is keyed by model profile only, so anything in it is
# shared by every caller. Only the SERVER's key may ever be baked into a cached
# client — a user's BYOK key gets a fresh, uncached instance, or one caller's
# credential would end up spending on another caller's request. `_get_llm`
# enforces that; do not add a key to this cache's key to "fix" the extra
# handshake, because that keeps user keys in process memory indefinitely.
_LLM_CACHE: dict[tuple[str, str, str | None], ChatOpenAI] = {}


def _get_llm(
    model: str,
    reasoning_effort: str | None,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> ChatOpenAI:
    """A client for `model` on `provider` (the server's when omitted), spending
    `api_key` (that provider's server key when omitted).

    Only the server-key path is cached — see the note on `_LLM_CACHE`.
    """
    provider = provider or providers.server()
    server_key = providers.server_key(provider)
    effective = api_key or server_key
    shareable = effective is not None and effective == server_key

    cache_key = (provider.id, model, reasoning_effort)
    if shareable:
        cached = _LLM_CACHE.get(cache_key)
        if cached is not None:
            return cached

    options: dict[str, Any] = {
        "model": model,
        "api_key": effective,
        "streaming": True,
    }
    if provider.base_url:
        options["base_url"] = provider.base_url
        # langchain routes some model names to OpenAI's Responses API, which
        # the other providers do not serve. Chat completions is what they share.
        options["use_responses_api"] = False
    # Decided by the model, not by the caller: a `reasoning_effort` aimed at a
    # chat model is dropped rather than passed through to a 400.
    options.update(providers.sampling_options(provider, model, reasoning_effort))
    llm = ChatOpenAI(**options)
    if shareable:
        _LLM_CACHE[cache_key] = llm
    return llm


async def warm_models(models: list[str], provider: Provider | None = None) -> None:
    """Open the provider connection before a user is waiting on it.

    The client is cached, but the cache is populated by the *first* request —
    which therefore pays DNS resolution and the TLS handshake to the API on top
    of normal generation. That lands squarely on the first spoken turn, the one
    users judge responsiveness by. A 1-token completion primes the connection
    pool through the exact code path a real turn uses.
    """
    for model in models:
        if not model:
            continue
        try:
            await _get_llm(model, None, provider=provider).ainvoke("hi", max_tokens=1)
            log.info("warmed model connection: %s", model)
        except Exception as e:  # noqa: BLE001 — warmup must never block startup
            log.warning("model warmup failed for %s: %s", model, e)

_DOC_DESC = (
    "Semantic search over the documents the USER has uploaded (PDFs, Word docs, notes). "
    "Use whenever the question could be answered from their files, or when they reference "
    "'the document', 'my notes', 'this report', a filename, etc. Returns passages tagged "
    "[1], [2], … that you MUST reuse when citing."
)
_WEB_DESC = (
    "Search the public web for facts that change or that you might misremember: news, current "
    "events, prices, releases, specific figures and dates, niche names — or when the user asks "
    "for sources. Do NOT search for things you already know (concepts, definitions, history), "
    "for chit-chat, or when the user is correcting what you heard ('I said X, not Y') or "
    "commenting on your last reply — answer those directly. Returns results tagged with "
    "citation numbers to reuse.\n"
    "The query MUST stand on its own: the search engine cannot see the conversation. Carry the "
    "subject over from earlier turns and name it in full — after discussing Spider-Man, ask for "
    "'Spider-Man Brand New Day movie', never 'movie brand new day', which retrieves nothing. "
    "Prefer the specific proper noun over generic words, and omit a year unless the user gave one.\n"
    "Spell the INTENT into the query, not just the subject: a follow-up like 'what about the "
    "Realme P4 5G?' after a phone-shopping question needs 'Realme P4 5G price specifications "
    "India', not the bare name. Search again only if the results clearly miss what was asked "
    "(a lone video, no figures) — once, with a sharper query, never the same words reshuffled."
)


def build_tools(
    session_id: str,
    store: DocumentStore | None,
    sources: list[dict],
    doc_ids: list[str] | None = None,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> list[StructuredTool]:
    """Per-request LangChain tools. `sources` is shared/mutable so citations
    surface to the route; numbering is global across tool calls.

    `api_key` belongs to `provider`, and is only handed to a tool that calls
    that same provider — never to one that would send it to another vendor.
    """
    provider = provider or providers.server()

    def _next_n() -> int:
        return len(sources) + 1

    async def search_documents(query: str) -> str:
        if store is None:
            return (
                "Document search is temporarily unavailable because the vector database is offline. "
                "Answer from general knowledge or the web when possible, and clearly say when the "
                "user's uploaded files cannot be checked."
            )
        if not api_key:
            return (
                "Document search is unavailable because no API key is set for this request. "
                "Tell the user to add their API key in settings, and answer from general "
                "knowledge in the meantime."
            )
        if not provider.embeddings:
            return (
                f"Document search is unavailable: it needs an OpenAI key, and this request "
                f"runs on {provider.label}, which cannot embed documents. Tell the user so "
                "in one short sentence, and answer from general knowledge or search_web."
            )
        # Same key that pays for the completion pays to embed the query.
        hits = await store.search(session_id, query, api_key, doc_ids=doc_ids)
        if not hits:
            if not await store.has_documents(session_id):
                return (
                    "No documents have been uploaded yet. If the user is asking about their "
                    "files, tell them to upload one; otherwise answer from general knowledge "
                    "or search_web."
                )
            return "No relevant passages found in the selected documents for that query."
        blocks: list[str] = []
        for hit in hits:
            n = _next_n()
            page = f" p.{hit['page']}" if hit.get("page") else ""
            label = f"{hit['doc_name']}{page}"
            sources.append({
                "n": n, "type": "document", "label": label,
                "doc_name": hit.get("doc_name"), "page": hit.get("page"),
                "snippet": (hit.get("text") or "")[:240], "url": None,
            })
            blocks.append(f"[{n}] {label}\n{hit['text']}")
        return "\n\n".join(blocks)

    async def search_web(query: str) -> str:
        # A key only ever pays for its own vendor's hosted search (OpenAI's web
        # search, Groq's browser search). A provider without one — or no key —
        # goes straight to the keyless tiers.
        hosted = provider.hosted_search
        results = await web_search.search(
            query, api_key=api_key if hosted else None, hosted=hosted,
        )
        if not results:
            # Not "retry": every search tier has already been tried for this
            # query, and a retry is another model round plus another search.
            return (
                f"No results for query={query!r}; the search service returned nothing. "
                "Answer from your own knowledge and say briefly that you couldn't verify it online."
            )
        blocks: list[str] = []
        for r in results:
            n = _next_n()
            title = r.get("title") or r.get("url") or "web result"
            sources.append({
                "n": n, "type": "web", "label": title, "url": r.get("url"),
                "snippet": (r.get("snippet") or "")[:240], "doc_name": None, "page": None,
            })
            blocks.append(f"[{n}] {title}\n{r.get('snippet', '')}\n{r.get('url', '')}")
        return "\n\n".join(blocks)

    return [
        StructuredTool.from_function(coroutine=search_documents, name="search_documents", description=_DOC_DESC),
        StructuredTool.from_function(coroutine=search_web, name="search_web", description=_WEB_DESC),
    ]


def to_lc_messages(history: list[dict], user_message: str) -> list:
    """Convert {role, content} history (last N turns) + the new user message
    into LangChain message objects."""
    trimmed = history[-(config.MAX_HISTORY_TURNS * 2):]
    msgs: list = []
    for m in trimmed:
        content = m.get("content", "")
        if m.get("role") == "assistant":
            msgs.append(AIMessage(content=content))
        elif m.get("role") == "user":
            msgs.append(HumanMessage(content=content))
    msgs.append(HumanMessage(content=user_message))
    return msgs


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


async def agent_stream(
    messages: list,
    system_prompt: str,
    tools: list[StructuredTool],
    max_iterations: int = 5,
    model: str | None = None,
    reasoning_effort: str | None = None,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> AsyncIterator[dict]:
    """Stream typed events while the model calls tools agentically.

    Yields {"type":"tool", "name", "query"} and {"type":"delta", "text"} — same
    contract the FastAPI route serialises to NDJSON.

    `api_key` is the caller's own key when they supplied one, for `provider`;
    omitted, the server's key and provider are used.
    """
    provider = provider or providers.server()
    base_llm = _get_llm(
        model or providers.models(provider).default, reasoning_effort, api_key, provider,
    )
    llm = base_llm.bind_tools(tools) if tools else base_llm
    tools_by_name = {t.name: t for t in tools}

    convo: list = [SystemMessage(content=system_prompt), *messages]

    # One log line per model round and per tool, so a slow turn says where its
    # time went: the model thinking, or a search waiting on the network.
    started = time.perf_counter()

    def ms(since: float) -> str:
        return f"{(time.perf_counter() - since) * 1000:.0f}ms"

    for round_no in range(1, max_iterations + 1):
        gathered = None
        round_started = time.perf_counter()
        first_token: str | None = None
        async for chunk in llm.astream(convo):
            text = _text_of(chunk.content)
            if text:
                if first_token is None:
                    first_token = ms(round_started)
                yield {"type": "delta", "text": text}
            gathered = chunk if gathered is None else gathered + chunk

        if gathered is None:
            return
        tool_calls = getattr(gathered, "tool_calls", None) or []
        log.info(
            "turn %s/%s round %d: %s, first text %s, %d tool call(s)",
            provider.id, base_llm.model_name, round_no, ms(round_started),
            first_token or "-", len(tool_calls),
        )
        if not tool_calls:
            log.info("turn done in %s", ms(started))
            return

        # Record the assistant turn (with its tool calls), then run each tool.
        convo.append(AIMessage(content=gathered.content or "", tool_calls=tool_calls))
        for tc in tool_calls:
            args = tc.get("args") or {}
            yield {"type": "tool", "name": tc.get("name", ""), "query": str(args.get("query", ""))}

        async def run(tc: dict) -> str:
            tool = tools_by_name.get(tc.get("name", ""))
            tool_started = time.perf_counter()
            try:
                result = await tool.ainvoke(tc.get("args") or {}) if tool else f"[error] unknown tool {tc.get('name')}"
            except Exception as e:  # noqa: BLE001
                log.exception("tool %s failed", tc.get("name"))
                result = f"[error] {e}"
            log.info("turn tool %s: %s", tc.get("name"), ms(tool_started))
            return str(result)

        # A round's calls run together: two searches cost the slower one, not
        # the sum. Results go back in call order, matched by tool_call_id.
        # Citation numbers are claimed as each tool finishes, which is fine —
        # every result block carries its own numbers.
        results = await asyncio.gather(*(run(tc) for tc in tool_calls))
        for tc, result in zip(tool_calls, results):
            convo.append(ToolMessage(content=result[:6000], tool_call_id=tc.get("id", "")))

    # The tool budget is spent, but the conversation now holds every result the
    # tools returned — often a dozen-plus sources. The old behaviour threw all
    # of that away and printed "[Stopped after several tool calls — please
    # rephrase]", which reads as a failure to the user when the research
    # actually succeeded. Run one final pass with the tools UNBOUND so the model
    # cannot keep searching and must write the answer from what it has.
    convo.append(SystemMessage(content=(
        "Your tool budget for this turn is spent — no more tool calls are possible. "
        "Write your complete answer NOW from the tool results above, citing the [n] "
        "numbers they carry. If some aspect remains unverified, note it in one short "
        "clause; never refuse or ask the user to rephrase."
    )))
    emitted = False
    try:
        async for chunk in base_llm.astream(convo):
            text = _text_of(chunk.content)
            if text:
                emitted = True
                yield {"type": "delta", "text": text}
    except Exception:  # noqa: BLE001 — the synthesis pass must not lose the turn
        log.exception("final synthesis pass failed")
    if not emitted:
        yield {
            "type": "delta",
            "text": "I gathered the sources below but hit this turn's tool budget before "
                    "finishing — ask me to continue and I'll pick up from what I found.",
        }
