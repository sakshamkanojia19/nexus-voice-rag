# How Nexus works

Nexus is a web app you can talk to. You upload documents, then ask questions — by typing
or just by speaking — and it answers out loud, pulling facts from your files and the live
web, with a numbered citation behind every claim.

This document explains how the whole thing fits together, in plain language. If you can
follow a conversation, you can follow this.

> Companion docs: [WORKFLOW.md](WORKFLOW.md) (step-by-step flows) ·
> [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) (file map) · [README.md](README.md) (setup).

---

## 1. The big picture: two programs talking to each other

Nexus is two programs:

```
┌─────────────────────────────┐          ┌──────────────────────────────┐
│  The frontend (your browser)│          │  The backend (a Python server)│
│                             │   HTTP   │                              │
│  • the whole user interface │ ◀──────▶ │  • talks to the AI model     │
│  • listens through your mic │          │  • searches your documents   │
│  • decides when you're done │          │  • searches the web          │
│    talking                  │          │  • turns speech into text    │
│  • speaks the answers       │          │  • checks who you are        │
└─────────────────────────────┘          └──────────────────────────────┘
```

**The frontend** is a React app (TypeScript, built with Vite). It runs entirely in your
browser and owns everything you see and hear: the chat screen, the landing page, the
microphone, the voice that reads answers back.

**The backend** is a FastAPI server (Python). It owns everything that needs secrets or
heavy lifting: calling OpenAI, storing document contents, running the speech-recognition
model on a GPU.

They talk over plain HTTP. When the backend answers a chat message, it doesn't send one
big blob — it streams the reply piece by piece (a format called NDJSON: one small JSON
object per line), which is why you see the answer appear word by word instead of waiting
in silence.

A deliberate design rule runs through everything: **the expensive, private things live on
the server; the free, personal things live in your browser.** Hearing you, deciding when
you've finished a sentence, and speaking replies all happen on your own machine and cost
nothing. Only the actual "thinking" (the LLM) is a paid, remote call — and it runs on
each user's own OpenAI key.

---

## 2. What happens when you speak to it

This is the heart of the project. Follow one spoken question through the pipeline:

**Step 1 — Hearing that you're speaking at all.**
A small neural network called Silero VAD (voice activity detection) runs *inside your
browser*, checking every 32 milliseconds: "is this a human voice, or just room noise?"
It's how Nexus knows you started talking without streaming your microphone anywhere.

**Step 2 — Knowing when you've finished. This is the part most voice bots get wrong.**
Most bots use a timer: three seconds of silence means you're done. That's why they cut
you off mid-thought. Nexus instead *reads what you've said so far* (`lib/endpointing.ts`):

- "What's the capital of…" ends in a dangling word — a person would wait, so Nexus waits
  (up to 4 seconds).
- "What's the capital of France?" is a complete sentence — Nexus answers after just 700ms.
- When the words are ambiguous, it listens to your *pitch* (`lib/prosody.ts`): a falling
  voice usually means you've finished, a rising one means you haven't. Same trick humans use.

**Step 3 — Turning your speech into text.**
Two recognizers run in parallel. The browser's built-in Web Speech API gives fast, rough
live text. For the accurate final version, the recorded audio goes to the backend's
`/transcribe` endpoint, where **faster-whisper** (an open-source speech model) runs on
your GPU. One trick makes this feel instant: transcription starts *during* the pause in
step 2 — while Nexus is politely waiting to make sure you're done, it has already begun
decoding. By the time the turn ends, the text is usually ready. Measured on a GTX 1650 Ti:
about 0.6 seconds from the moment you stop speaking to a finished transcript.

**Step 4 — Not hearing itself.**
The microphone stays open while Nexus talks (so you can interrupt it), which means its own
voice leaks back in through your speakers. Without defences it would transcribe itself,
mistake that for you talking, and spiral. `lib/echo.ts` compares everything the mic hears
against what Nexus is currently saying, and throws away the matches — down to cutting
individual echoed sentences out of a mixed recording where you and it overlap.

**Step 5 — Thinking.**
The transcript goes to the backend's `/chat` endpoint (section 3).

**Step 6 — Speaking the answer.**
The browser's own text-to-speech reads the reply — free, offline, no cloud. It doesn't
wait for the full answer: the first sentence is being spoken while the second is still
streaming in. Every system voice gets a persona with a locale-matched name (Priya for
Hindi, Kai for UK English, Greta for German), and an animated particle sphere breathes in
rhythm with the actual words being spoken.

**Interrupting — the case that runs through all of it.**
If you start talking while Nexus is talking, it doesn't stop instantly (you might have
just coughed) and it doesn't ignore you. It **pauses** and waits ~1.2 seconds for
evidence. Real words arrive → it commits: playback stops, the model's memory of the
conversation is trimmed to *only the words you actually heard*, so it never believes it
said things you never heard. Nothing valid arrives → it resumes exactly where it paused,
mid-sentence. Two-phase barge-in: pause, confirm, then resume or commit.

---

## 3. What happens when it thinks

The backend doesn't decide *how* to answer — the model does. `agent.py` hands the LLM two
tools and lets it choose, in a loop:

- **`search_documents`** — semantic search over the user's uploaded files
- **`search_web`** — live web search

A question it already knows ("what's photosynthesis?") gets answered directly, zero
tools, fastest possible reply. "What does my contract say about notice periods?" makes it
call `search_documents`. "Compare my Q3 deck against current market prices" makes it call
both and merge the results. There are no keyword triggers or regex rules deciding this —
the model routes itself.

Every tool result comes back tagged with a number — `[1]`, `[2]`, … — and the system
prompt (`context_builder.py`) requires the model to cite those numbers for its claims.
In the UI they become clickable chips pointing at the exact document page or URL.

The loop has a budget (5 rounds of tool calls; 2 for voice, where speed matters more).
When a deep-research question exhausts the budget, Nexus doesn't apologise and give up —
it takes one final pass with the tools switched off, forcing the model to write the best
answer it can from everything already gathered.

**Searching your documents** works on a simple idea: text can be converted into
coordinates ("embeddings") where similar meanings land close together. On upload, files
are split into overlapping chunks, each chunk gets its coordinates from OpenAI's embedding
model, and everything is stored in **Qdrant** (an open-source vector database). A question
gets the same treatment, and the nearest chunks — by meaning, not keywords — come back.
That's the "RAG" in Retrieval-Augmented Generation, and it's why "what does the contract
say about leaving?" finds the clause that says "termination".

**Searching the web** walks a trust ladder in `web_search.py`: OpenAI's hosted search
(best: real citations with dates) → Tavily if a key is configured → last resort, a scraped
search with a relevance guard that checks results actually contain the query's terms, so
a blocked or garbage response can never fabricate a citation. Results are cached for five
minutes.

---

## 4. Who pays, and how sign-in works

Nexus is built so the person running the server never pays for strangers.

- **Sign-in** is Supabase (Google, one click). The frontend gets a signed token; the
  backend verifies it cryptographically on every request (`auth.py`, `identity.py`) —
  it never just trusts the browser.
- **BYOK — bring your own key.** Each user pastes their own OpenAI, xAI (Grok) or Groq
  key; its prefix decides which provider it runs on (`providers.py`). It's stored only
  in their browser's localStorage, sent with each request, used for that one request,
  never written to disk or logs on the server, and redacted from error messages
  (`credentials.py`). Signing out deletes it from the browser.
- With `REQUIRE_AUTH=true` and `REQUIRE_USER_API_KEY=true` (the public-deployment
  settings), anonymous visitors can look at everything but can't spend a cent of the
  operator's money.

The frontend enforces this gently (`lib/accessGate.ts`): the whole app loads for anyone,
and only the first action that would *spend money* — sending a message, uploading a file —
triggers the sign-in / add-key flow. After it's satisfied, the action you originally
attempted runs automatically.

---

## 5. Where your data lives

| What | Where | Why there |
|---|---|---|
| Conversations | Browser localStorage, keyed per account, synced to Supabase | Instant to load locally; sync makes them follow you across devices |
| Documents | Qdrant (chunks + embeddings), scoped per account | Semantic search needs a vector database; survives restarts |
| Your API key | Browser localStorage **only** — never the server | It's your money; deleted the moment you sign out |
| Voice audio | Nowhere — processed and discarded | Transcripts are the only thing kept, inside the conversation |

If Qdrant is down, document search degrades gracefully — chat and voice keep working, and
the model is told to say plainly that it can't check your files right now.

---

## 6. The API between the two halves

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Is the server up, and what's configured |
| GET | `/models` | Which chat models the picker can offer |
| GET | `/suggest` | Autocomplete suggestions under the hero search box |
| POST | `/chat` | The main event: streams the answer as NDJSON (`tool` · `delta` · `sources` · `done`) |
| POST | `/upload` | Ingest documents (parse → chunk → embed → store) |
| GET / DELETE | `/documents`, `/documents/{id}` | List and remove your documents |
| GET / PUT / DELETE | `/conversations…` | Cross-device conversation sync |
| POST | `/transcribe` | Audio in, text out (faster-whisper) |
| WS | `/ws` | Same chat events over a WebSocket |

---

## 7. A map of the code

### Backend (`backend/`) — one job per file

| File | Plain-language job |
|---|---|
| `main.py` | The front door: all routes, streaming, wiring |
| `agent.py` | The thinking loop: gives the model its tools and streams what it does |
| `context_builder.py` | Writes the model's instructions each turn: cite sources, match the user's language, keep spoken replies short, label stale prices |
| `web_search.py` | The web-search trust ladder |
| `vectorstore.py` | Documents in and out of Qdrant |
| `stt.py` | Speech-to-text: GPU faster-whisper with an automatic fallback ladder down to CPU — voice never dies because CUDA broke |
| `auth.py` / `identity.py` | Verifies who is calling; never trusts the browser |
| `credentials.py` | Handles user keys without ever keeping them |
| `providers.py` | Which API a key belongs to, and what that provider can and can't do |
| `conversations.py` | Conversation sync storage |
| `suggest.py` | Search suggestions |
| `config.py` | Reads `.env`; every knob documented inline |

### Frontend (`frontend/src/`)

| Where | What lives there |
|---|---|
| `lib/` | The brains, as pure TypeScript modules with **zero dependencies** — endpointing, prosody, echo defence, voice gating, the access gate, agent naming. Each ships with a `.test.mjs` beside it, and the test cases come from real captured failures, not invented inputs |
| `hooks/` | React glue: `useVoice` (mic, VAD, both recognizers, speculative decode), `useSpeech` (TTS queue, barge-in hold/resume), `useChat` (the NDJSON stream → chat turns), `useAuth`, `useDocuments`, `useAccessGate` |
| `components/rag/` | The app: `RagApp` (orchestrator), `Composer`, `Conversation`, `VoiceChatPage` + `VoiceOrb` (the breathing sphere), `DocumentsPage`, `VoiceAgentsPage`, `Sidebar` |
| `components/landing/` | The marketing page served at `/` for signed-out visitors |
| `components/auth/` | Sign-in and add-your-key panels |

Routing is one SPA, like ChatGPT: `/` is the landing page (signed-in users bounce straight
to `/chat`), and `/chat`, `/documents`, `/projects`, `/voice-agents` are the app views.

The split between `lib/` and `hooks/` is the codebase's strongest opinion: anything that
can be a pure function *is* one, so the tricky logic (when is a sentence finished? is this
echo?) is testable with `node` alone — no browser, no mocks.

---

## 8. A note on history

*A note on history: Nexus began life as an embeddable chat widget that intercepted a host
app's network traffic. In May 2026 it was rebuilt as this standalone product; nothing of
the interception design survives.*
