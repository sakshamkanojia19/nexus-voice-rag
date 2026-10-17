# Nexus — Workflow & Data-Flow Reference

ASCII flows for every major path through the app. Pair this with
[ARCHITECTURE.md](ARCHITECTURE.md) (what each piece is) and
[PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) (where each piece lives).

Legend:  `──▶` call / data   ·   `◀──` response / stream   ·   `[ ]` component/module   ·   `{ }` event/payload

---

## 1. System overview

```
           BROWSER  (React 18 · Vite · strict TS)                      SERVER  (FastAPI)
┌───────────────────────────────────────────────────┐    ┌───────────────────────────────────────────────┐
│ [RagApp]  orchestrator: views · voice loop ·      │    │ [main.py]  routes · CORS                      │
│           barge-in · spoken fillers               │    │   every route: [auth] Principal → owner_key   │
│   ├─ [Sidebar]  recents · account · API key       │    │   paid routes: [credentials] key + provider   │
│   ├─ [HeroSearch] / [Conversation] + [Composer]   │    │                                               │
│   ├─ [DocumentsPage]  upload · select · delete    │    │ POST /chat ──▶ [agent] tool-calling loop      │
│   └─ [VoiceChatPage]  live call · [VoiceOrb]      │    │     ├─ search_documents ──▶ [vectorstore]     │
│                                                   │    │     └─ search_web ────────▶ [web_search]      │
│ hooks: useAuth · useAccessGate · useChat ·        │    │ POST /upload ──▶ [vectorstore] ──▶ Qdrant     │
│        useDocuments · useVoice · useSpeech        │    │ POST /transcribe ──▶ [stt] local | hosted     │
└────────────────────────┬──────────────────────────┘    │ /conversations ──▶ [conversations] Postgres   │
                         │                               │ GET /health · /models · /suggest · WS /ws     │
                         │  lib/api.ts                   └───────────────────────────────────────────────┘
                         │  Authorization: Bearer <JWT>                 │
                         │  X-Provider-Key: <user key>                  ├──▶ OpenAI / xAI / Groq  (chat)
                         │  nexus_anon cookie                           ├──▶ Qdrant Cloud  (vectors)
                         │  NDJSON stream reader                        ├──▶ Supabase Postgres  (history)
                         └──────────────────────────────────────▶       └──▶ search tiers  (web)

   [useAuth] ◀──▶ Supabase Auth  (Google · email link · password)  →  JWT for every API call
```

The browser does voice activity detection, live partial transcripts, turn-end decisions and speech
synthesis locally. The server owns identity, the agent loop, retrieval, web search, transcription and
history storage. `/ws` is a WebSocket form of `/chat` for non-browser clients; it runs on the server's
own key.

---

## 2. Sign-in and access  (Supabase auth + BYOK key gate)

### Client: the gate

```
page load
   ├─▶ GET /health ──▶ { auth.required, byok.{accepted, required, requires_auth, server_key_available}, … }
   │                        └─▶ [useAccessGate] requirementsFrom(caps)
   └─▶ [useAuth] supabase.auth.getSession() + onAuthStateChange
             └─▶ setAccessToken(jwt)   → lib/api.ts adds "Authorization: Bearer <jwt>" to every call

user action:  send a question · start a voice call · upload files
   │
   ▼
access.gate(intent) ── all requirements met? ── yes ──▶ run the action now
   │ no → park the intent  {kind:"chat", text} | {kind:"voice"} | {kind:"upload", files}
   ▼
step "signin"  →  [AuthPage]  Google OAuth · one-time email link · email + password
   │ SIGNED_IN
   ▼
key still required? ── no ──▶ replay the parked intent (same text, same files)
   │ yes
   ▼
return the user to the app, question back in the composer   (account first, key on the next action)
   │ next action
   ▼
step "apikey"  →  key checked against its prefix pattern, saved in localStorage
   │
   ▼
replay the parked intent
```

The order is fixed by `lib/accessGate.ts`: a key step is unreachable until an account exists, because
the server only honours a key from a signed-in caller. If the server refuses something the client did
not predict, `lib/api.ts` maps `401 → AccessError("signin")` and `402 → AccessError("apikey")`;
`useAccessGate.handleAccessError` re-probes `/health` and opens the matching step.

### Server: who is calling

```
request ──▶ auth.get_principal
              ├─ Bearer JWT present → verify signature (JWKS for RS*/ES*, shared secret for HS256),
              │                       aud = "authenticated", exp + sub required
              │                       └─▶ Principal(kind="user", subject=<supabase uuid>)
              └─ otherwise → "nexus_anon" cookie (httpOnly, 256-bit, minted on first visit)
                                      └─▶ Principal(kind="anon", subject=<token>)

          owner_key = "<kind>:<subject>"   ──▶ scopes Qdrant points and conversation rows

          auth.require_principal  (/chat · /upload · /documents · /transcribe · /conversations)
              └─ REQUIRE_AUTH and caller is anonymous ──▶ 401 "Sign in to continue."
```

No route takes an owner id from the request body or path. On `SIGNED_IN` / `SIGNED_OUT`, `RagApp`
refetches documents, clears the document selection, swaps the conversation bucket, stops any voice
capture or speech, and on sign-out deletes the stored API key from the browser.

---

## 3. Document upload & indexing  (`/upload`, Qdrant, per account)

```
USER drops or picks files   ([DocumentsPage] drop zone · [Composer] paperclip)
        │
        ▼
[RagApp.attachFiles]
   • key provider is not OpenAI → explain that uploads use an OpenAI key for embeddings (no request)
   • access.gate({kind:"upload", files})
        │
        ▼
[useDocuments.addFiles]
   • keep .pdf .docx .txt .md .markdown .text .log .csv
   • push optimistic placeholders  (status: "processing")
        │  POST /upload   multipart files[]   + Bearer JWT · X-Provider-Key
        ▼
[main.upload]
   • require_principal → owner_key
   • get_credentials → require_usable(key)   (no key at all → 503 with what to set)
   • provider.embeddings is false → 400 "Uploading documents needs an OpenAI key …"
   • per file: larger than MAX_UPLOAD_MB (25) → {status:"error"}; otherwise ↓
        │
        ▼
[DocumentStore.add(owner_key, name, bytes, api_key)]
   parse   .pdf → pypdf (per page) · .docx → python-docx · text → UTF-8      ⇒ [(page | None, text)]
   split   RecursiveCharacterTextSplitter, ~800-token chunks, 120-token overlap
   tag     metadata {session_id ← owner_key, doc_id, doc_name, page}
   embed   OpenAIEmbeddings (text-embedding-3-small) on the caller's own key
   upsert  Qdrant collection (cosine, 1536-d, keyword indexes on owner and doc_id)
        │
        ▼  { documents: [ {doc_id, name, size, status:"ready"|"error", error, n_chunks, pages[]} ] }
[useDocuments]
   • replace placeholders with server metadata
   • auto-select every newly ready document (it grounds the next question)
   • surface a per-file error in the documents toast
```

```
GET    /documents          ──▶ store.list(owner_key)            scroll payloads, no embedding call
DELETE /documents/{doc_id} ──▶ store.delete(owner_key, doc_id)  filter = owner AND doc_id
```

Selection is explicit: nothing is grounded until the user selects a document or uploads one, and
**New chat** clears the selection. The selected ids travel as `doc_ids` on every chat request, and
their titles are added to the Whisper prompt so spoken document names transcribe correctly.

---

## 4. Text chat turn  (`/chat`, NDJSON stream)

```
USER presses Enter in [Composer]
        │
        ▼
[RagApp.handleSend] ──▶ access.gate({kind:"chat", text}) ──▶ sendNow(text)
        │
        ▼
[useChat.send(text, {mode, thinking, model, docIds, replyLanguage})]
   • first message creates the conversation id
   • append user turn + empty "streaming" assistant turn
   • history = up to 18 earlier turns; an interrupted reply is sent as
     "<what was heard> [the user interrupted me here]"
        │  POST /chat { message, conversation_history, stream:true, bot_name, from_voice:false,
        │               doc_ids, reply_language, mode:"instant"|"web"|"deep", thinking, model }
        ▼
[main.chat]
   1. identity.match_identity_intent  → exact identity question → canned {delta} + {done}, no model call
   2. require_usable(creds)           → key + provider   (see §8)
   3. _prepare  → system prompt: identity · today's date · document titles · reply style ·
                  reply language · mode notes;  history → LangChain messages (last 10 exchanges)
   4. _agent_profile → model + tool budget
        instant → instant model, 1 round, no tools
        web     → default model, up to 5 rounds
        deep    → deep model,    up to DEEP_MAX_ITERATIONS (8) rounds
        model   → honoured only if it is in the provider's allowlist
        thinking→ reasoning model + reasoning_effort
   5. agent.build_tools(owner_key, store, sources[], doc_ids, key, provider)
        │
        ▼  StreamingResponse  application/x-ndjson
   {"type":"meta","model":…,"provider":…}                                     ← always first
  ┌─ AGENT LOOP  agent.agent_stream · ChatOpenAI(streaming).bind_tools ─────────────────────────────┐
  │  llm.astream(convo) ── text chunks ─────────────────────────────▶ {"type":"delta","text":…}     │
  │        │ tool_calls in the gathered message?                                                    │
  │        ├─ none → turn complete                                                                  │
  │        └─ per call:  {"type":"tool","name":…,"query":…}  then run it                            │
  │             search_documents(q) → store.search(owner_key, q, key, doc_ids)   top-k 6, cosine    │
  │                  sources += {n, type:"document", label:"report.pdf p.3", page, snippet}         │
  │                  returns "[n] report.pdf p.3\n<passage>" …                                      │
  │             search_web(q) → web_search.search(q)                                                │
  │                  sources += {n, type:"web", label:<title>, url, snippet}                        │
  │                  returns "[n] <title>\n<snippet>\n<url>" …                                      │
  │           tool result → ToolMessage (≤6000 chars) → next round                                  │
  │  budget spent → one more pass with tools unbound: answer from the gathered results              │
  └─────────────────────────────────────────────────────────────────────────────────────────────────┘
   {"type":"sources","items":[…]}   (when any tool produced sources)
   {"type":"done"}
```

Citation numbers are global for the turn: every tool call appends to the same `sources` list, so the
`[n]` markers the model writes match the chips the UI renders.

### Web search tiers  (`web_search.search`)

```
query ──▶ 5-minute cache (keyed by query) ── hit ──▶ results
   │ miss, WEB_SEARCH_PROVIDER = auto
   ▼
1. OpenAI hosted web_search  (only when the request runs on an OpenAI key) → url_citation annotations
2. Tavily API                (when TAVILY_API_KEY is set)                  → structured JSON results
3. DuckDuckGo via ddgs       (3 region/backend attempts, relevance filter on every result)
4. Wikipedia                 (opensearch + REST page summary)
   ▼  first tier with results wins → [{title, snippet, url}]
```

### Client side of the stream

```
[lib/api.streamChat]  read body → split on "\n" → JSON.parse → ChatEvent
        │
        ▼
[useChat] maps each event onto the streaming assistant turn
   meta    → turn.model, turn.provider          ("Answered by …" label)
   tool    → turn.tools += {name, query, startedAt}   ([SearchActivity] steps)
   delta   → turn.content += text                (markdown renders as it streams)
   sources → turn.sources = items               ([n] chips + [Sources] row in [MessageItem])
   done    → status "complete", endedAt          (duration summary)
   error   → status "error", message shown in the turn
        │
        ▼
onAssistantFinal(text, fromVoice)  → speech when the turn came from voice (§5)
```

### NDJSON event grammar

```
{"type":"meta",    "model":"gpt-…", "provider":"openai"}
{"type":"tool",    "name":"search_documents", "query":"refund policy in the 2025 handbook"}
{"type":"delta",   "text":"The handbook allows refunds within "}
{"type":"sources", "items":[{"n":1,"type":"document","label":"handbook.pdf p.12", …},
                            {"n":3,"type":"web","label":"…","url":"https://…"}]}
{"type":"done"}
{"type":"error",   "message":"OpenAI rejected your API key. …"}    ← terminal
```

Upstream 401 / 403 / 404 / 429 responses become one plain sentence naming the provider and the fix;
every other error text passes through `redact()` before it reaches the client.

---

## 5. Voice turn end-to-end

Two entry points share one pipeline: the **mic button** in the Composer (one turn, live words shown in
the input) and the **live call** in [VoiceChatPage] (continuous, hands-free, interruptible).

### 5a. Capture → endpoint → transcript  (browser)

```
start call ── access.gate({kind:"voice"}) ──▶ enterVoiceChat
   speech.unlock() · audio cues unlocked · TTS on · view = "voicechat"
   effect: whenever voice.state is "idle" and the mic is not muted → voice.start()
        │
        ▼
[useVoice.openSession]   once per call; later turns reuse it
   getUserMedia({ echoCancellation, … })
   ├─ Silero VAD v5   (AudioNodeVAD, assets served same-origin from /vad/, 16 kHz frames)
   │     onFrameProcessed → level meter · adaptive noise floor · pitch tracking (prosody)
   ├─ Web Speech recognizer   (continuous, interim results)  → live partial text
   └─ MediaRecorder           (when Web Speech is off or STT mode is "whisper")
        │
        ▼
VAD onSpeechStart ("maybe") ─▶ onSpeechRealStart (≥280 ms of speech) ─▶ … ─▶ onSpeechEnd(audio)
   • voice-gate.judgeLoudness(peak, noiseFloor): absolute floor AND signal-to-noise ratio
       fail between turns → segment dropped    fail mid-turn → segment dropped, turn kept
   • prosody.judgeProsody → contour: falling | rising | level | unknown
   • segments.push(audio) → considerEndpoint()
        │
        ▼
considerEndpoint   (lib/endpointing.ts: decide from the words, nudge with the pitch)
   only filler ("um", "uh")            → keep listening up to 4000 ms, discard if nothing follows
   judgeEndpoint(partial text, contour)
     complete    terminal punctuation · Hindi sentence-final verb ·
                 short stand-alone phrase · question of 5+ words              → wait  700 ms
     continuing  1–2 words · ends on a conjunction / preposition / article    → wait 4000 ms
     unclear     anything else                                                → wait 1600 ms
                   + falling pitch → complete,   wait  900 ms
                   + rising pitch  → continuing, wait 2600 ms
     complete + rising pitch                                                  → wait 1200 ms
   during the wait: speculative Whisper on all segments so far (when Whisper will be used)
   user speaks again → onSpeechStart cancels the timer; the fragments become one turn
   backstops: 45 s per turn, 4 consecutive holds
        │ timer fires
        ▼
deliverTurn → transcript source
   Web Speech text   (auto mode, recognizer working, and enough words for the audio length)
   otherwise Whisper:
     speculative result whose audio fingerprint matches → reuse it
     else POST /transcribe  { WAV of every segment, prompt (domain terms + selected doc titles), language }
   cleanTranscript → drop known hallucinations and prompt echoes → onTranscript(text)
```

### 5b. Transcription  (server)

```
POST /transcribe ──▶ require_principal · get_credentials
        │
        ▼
stt.transcribe(audio, prompt, language, key, provider)
   STT_BACKEND = local (default) → faster-whisper on this machine
        model "auto": large-v3-turbo on CUDA, base on CPU   (loaded once, warmed at startup)
        language hint · initial_prompt · beam search · temperature fallback ·
        condition_on_previous_text = False · built-in VAD filter ·
        per-segment filters: no_speech_prob, avg_logprob, stock phrases, prompt echo
   STT_BACKEND = openai           → the key's own provider: OpenAI or Groq transcription endpoint
   the two backends back each other up; an xAI key transcribes locally
        │
        ▼  { text, backend }
```

### 5c. Answer → speech  (browser + server)

```
[RagApp.onTranscript(text)]
   • echo checks while the assistant may be audible (§6)
   • reply still playing → commitInterrupt()  (§6)
   • arm the thinking filler (1.4 s)
   • chat.send(text, { fromVoice:true, docIds, replyLanguage })
        │  POST /chat { …, from_voice:true }
        ▼
[main.chat]  voice profile — the composer's mode chips do not apply
   greeting / thanks / goodbye pattern → quick-voice model, short prompt, no tools
   anything else → voice model, search_documents + search_web, up to 2 tool rounds,
                   spoken-style reply rules in the system prompt
        │  NDJSON as in §4
        ▼
[RagApp]  what the user hears, in order
   1.4 s with no text and nothing said yet → thinking filler  "Hmm, let me think."
   {tool} event, nothing said yet          → search ack       "Let me check that."
                                             (one of the two per turn, English or Hindi)
   {delta} events → speech.streamPush(fullText)
        │
        ▼
[useSpeech]  sentence-chunked browser TTS (speechSynthesis)
   cleanForSpeech: drop code blocks, [n] markers, URLs, markdown symbols; "x.ai" → "x dot ai"
   split on sentence ends  . ! ? …  ।  ॥  。 ！ ？  ؟   → queue
   first chunk only: cut the opening clause (20–90 chars) so audio starts before sentence one ends
   each chunk → SpeechSynthesisUtterance
       voiceForText: the text's script picks the voice (lib/script-lang.ts), e.g. Devanagari → a
                     Hindi voice even during an English call; offline voices ranked first
       onboundary → record how much of the chunk has been spoken
       onend      → next chunk
   {done} → speech.streamEnd(fullText) flushes the trailing partial sentence
        │
        ▼
playback ends → mic re-armed for the next turn (it stayed open throughout for barge-in)
```

The call screen's orb follows one derived state: `listening → understanding` (transcribing, or waiting
for the first token) `→ thinking → speaking → idle`. From the Composer mic, the reply streams as text
and is read aloud once complete.

---

## 6. Barge-in / interruption

The mic stays live while the assistant talks. Every candidate interruption is first checked against
the assistant's own audio, then handled in two phases so a false alarm costs nothing.

```
assistant is speaking or streaming                               the mic hears speech
                                                                          │
          ┌───────────────────────────────────────────────────────────────┴──────────────────┐
          ▼ Web Speech partial text                                     ▼ no words yet (Whisper path)
  classifyCandidate: ≥500 ms of speech, ≥1 word,                 VAD speech sustained ≥500 ms
  at most every 260 ms                                           over playback
          │                                                               │
  onSpeechCandidate(text)                                        onAcousticBargeIn
    lone low-information word        → "echo"                        holdAssistant(4000 ms)
    matches what the assistant said  → "echo" (latched for the
                                        utterance unless 3+ new words arrive)
    otherwise → holdAssistant(1200 ms) → "interrupt"
          │                                                               │
          └──────────────────────────────┬────────────────────────────────┘
                                         ▼
PHASE 1  speech.hold()
   streamed reply  → cancel audio at once; the heard part goes to the spoken log;
                     the unheard rest of the sentence goes back to the front of the queue
   one-off speech  → pause()
   the LLM stream keeps running; new sentences queue behind the hold
                                         │
               ┌─────────────────────────┴──────────────────────────┐
               ▼ timer expires, no valid transcript                 ▼ validated transcript arrives
  recoverFalseInterruption                                PHASE 2  commitInterrupt
    still listening / transcribing → extend the hold         heard = speech.getSpokenText()
    otherwise speech.release() → resumes on the              speech.cancel() · chat.abort()
    word it stopped at                                       chat.truncateLastAssistant(heard)
                                                               → reply cut to what was heard,
                                                                 marked interrupted
                                                             chat.send(new transcript)
```

### Echo gating

```
while the assistant may be audible  (speaking, streaming, or within 2.5 s after audio ends)
   VAD thresholds  0.60 / 0.40  →  0.85 / 0.60     quiet speaker bleed fails acoustically
   Whisper round trip skipped for audio already judged echo
   transcript arrives:
     stripAssistantEcho        → remove sentences that match the reply being spoken
     salvageEcho               → when our sentence is glued to the front, keep the user's part
     isLowInformationBargeIn   → drop lone garbled fragments
     isLikelyAssistantEcho     → drop the rest of the echo; playback resumes
```

On the next request the interrupted reply goes into history as
`"<heard text> [the user interrupted me here]"`. The system prompt tells the model that text before
the marker is exactly what the user heard, so it follows a change of subject instead of finishing the
old answer.

---

## 7. Conversation sync

The browser's cache is what the UI reads; the server copy makes history follow the account across
devices.

```
local cache   localStorage "nexus_convos_<owner>"     owner = "user:<uuid>" | "anon"
              most recent 40 conversations · 80 turns each
              account change → swap bucket, clear the view; old unscoped buckets purged on load

sign-in / page load  (signed-in accounts)
   GET /conversations ──▶ { conversations:[{id, title, updated_at}], synced }     titles only
        │
        ▼
   mergeConversations   last write wins on updatedAt
     only on the server  → stub {needsFetch:true}
     newer on the server → keep local copy on screen, mark needsFetch
     newer locally, or never uploaded → toPush (≤10 per sync) ──▶ PUT /conversations/{id}

open a conversation
   render the cached copy at once
   needsFetch → GET /conversations/{id} ──▶ replace messages, clear needsFetch

a turn settles  (never mid-stream)
   write to the local cache ──▶ debounce 1.2 s ──▶ PUT /conversations/{id} { title, messages }

delete
   remove locally first ──▶ DELETE /conversations/{id}

server  [conversations.py]
   PostgREST over httpx with the service-role key
   upsert on (owner_key, id) · newest 200 messages kept · list sorted by updated_at
   sync not configured → { synced:false }, the app runs from the local cache
```

---

## 8. Key routing  (BYOK)

```
BROWSER
   key saved in localStorage (prefix-validated) ──▶ header  X-Provider-Key: <key>  on every request
   [ModelMenu] refetches GET /models whenever the saved key's provider changes

SERVER  credentials.get_credentials
   header present and ALLOW_USER_API_KEYS
      ├─ REQUIRE_AUTH_FOR_USER_KEY and caller is anonymous
      │     ──▶ 401 "Sign in before using your own API key."
      ├─ providers.for_key(key)
      │     sk-…   → OpenAI       default endpoint
      │     xai-…  → xAI (Grok)   OpenAI-compatible base_url
      │     gsk_…  → Groq         OpenAI-compatible base_url
      │     other  → 400  (the value is never echoed)
      └─▶ Credentials(api_key=key, provider, user_supplied=True)
   no header
      ├─ REQUIRE_USER_API_KEY → 401 (anonymous) · 402 "requires your own API key" (signed in)
      └─▶ server's PROVIDER and its key   (Credentials, user_supplied=False)
```

What each key powers, and where each feature runs:

```
              chat          embeddings (upload,          web search                transcription
                            search_documents)
OpenAI  sk-   OpenAI        OpenAI                       OpenAI hosted, then       OpenAI or local
                                                         keyless tiers
xAI     xai-  xAI           uploads use an OpenAI key    keyless tiers             local faster-whisper
Groq    gsk_  Groq          uploads use an OpenAI key    keyless tiers             Groq or local

keyless tiers = Tavily (server-configured) → DuckDuckGo → Wikipedia
```

Rules the routing enforces:

- **Never persisted.** The key lives in the request scope only: no disk, no database, no module cache.
- **Never logged.** Log lines and error bodies go through `redact()`, which masks anything key-shaped,
  including upstream error text that quotes the rejected key.
- **Never sent to another vendor.** A feature the key's provider lacks takes its keyless path or is
  refused with a clear message (uploads → 400); an xAI or Groq key never reaches OpenAI.
- **Never swapped for the server key.** A request carrying a user key is served on that key only.
- **Never shared between callers.** Model clients built on the server key are cached; a user key gets
  a fresh client per request. Vector-store clients are cached by a SHA-256 digest of the key.
- **Visible.** The first stream event, `{"type":"meta","model","provider"}`, tells the UI which
  provider and model answered, and the turn is labelled with it.
- **Removed on sign-out.** Signing out deletes the stored key from the browser.

`/ws` cannot carry a header from a browser, so it never accepts a user key: it serves turns on the
server's key and refuses when the deployment requires user keys.
