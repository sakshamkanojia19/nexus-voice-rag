# Nexus — Project Structure

Annotated map of the codebase: every source file and what it is responsible for. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the "why" and [WORKFLOW.md](WORKFLOW.md) for the
end-to-end flows.

```
nexus/
├── backend/                              FastAPI service (Python)
│   ├── __init__.py                       package marker (empty)
│   ├── main.py                           ★ app + routes: /health /suggest /models /chat (NDJSON stream) /upload
│   │                                       /documents /conversations /transcribe /ws; search-mode → tool selection
│   ├── agent.py                          ★ LangChain agent: build_tools() (StructuredTools search_documents /
│   │                                       search_web → [n] sources) · agent_stream() (ChatOpenAI.bind_tools +
│   │                                       streaming loop → tool/delta dict events); per-model client cache (server key only)
│   ├── vectorstore.py                    ★ Qdrant DocumentStore: parse → chunk → embed (OpenAIEmbeddings) → upsert;
│   │                                       add/search/list/delete, every query filtered by owner key; persistent
│   ├── providers.py                      ★ routes a key by prefix (sk- OpenAI, xai- xAI Grok, gsk_ Groq) to that
│   │                                       provider's OpenAI-compatible endpoint; declares embeddings / web search / STT per provider
│   ├── credentials.py                    ★ BYOK: reads the user key from the request header, validates format,
│   │                                       redacts it from logs/errors, never persists or caches it; signed-in callers only
│   ├── auth.py                           ★ request identity: verifies Supabase JWTs (JWKS) or issues an httpOnly
│   │                                       anonymous cookie → Principal.owner_key; identity never read from the body
│   ├── conversations.py                  conversation history in Supabase Postgres via PostgREST (list/get/upsert/delete),
│   │                                       scoped by owner_key; degrades to the client's local cache when unavailable
│   ├── context_builder.py                system prompts per mode (agent / instant / quick voice): persona, today's date,
│   │                                       documents, citations, reply language, voice tone; history trimming
│   ├── identity.py                       product identity: identity_prompt() for every system prompt +
│   │                                       match_identity_intent() deterministic answers to "who made you"-style questions
│   ├── web_search.py                     tiered web search: OpenAI hosted tool → Tavily → ddgs scrape (relevance-filtered)
│   │                                       → Wikipedia; 5-min cache; format_results()
│   ├── suggest.py                        search-query autocomplete proxy (Google, DuckDuckGo fallback), bounded TTL cache
│   ├── stt.py                            transcribe(): local faster-whisper (CPU or CUDA, model fallback ladder, warm-up,
│   │                                       hallucination filter) or hosted Whisper on the request's provider
│   ├── config.py                         loads backend/.env: providers + models, search modes, embedding/RAG, STT,
│   │                                       auth/BYOK policy, Supabase, CORS, port
│   ├── assets/
│   │   └── warmup.wav                    short spoken sentence decoded at boot so the first real turn is fast
│   ├── migrations/
│   │   └── 001_conversations.sql         conversations table, primary key (owner_key, id), jsonb messages; idempotent
│   ├── *_test.py                         offline test suites, run as `python -m backend.<name>_test`:
│   │                                       auth_test (forged ownership is rejected) · credentials_test (key handling) ·
│   │                                       providers_test (key → own provider only) · conversations_test (owner isolation,
│   │                                       no hard Supabase dependency) · stt_test (fallback ladder, hallucination filter) ·
│   │                                       identity_test (identity fast path) · web_search_test (relevance guard)
│   ├── .env.example                      documented settings template
│   └── .env                              (gitignored, copy from .env.example)
│
├── frontend/                             React 18 + Vite + TypeScript (strict) + Tailwind v3
│   ├── index.html                        HTML shell: dark class, icons + manifest, Inter + Newsreader fonts, title "Nexus"
│   ├── package.json                      deps: react, react-router-dom, supabase-js, vad-web, framer-motion, gsap,
│   │                                       lottie-react, three, react-markdown, radix, lucide; scripts dev/build/lint/test
│   ├── package-lock.json                 locked dependency tree
│   ├── vite.config.ts                    Vite + React plugin, @ alias, middleware serving /vad/*.mjs unmodified
│   ├── tailwind.config.ts                design tokens (HSL CSS vars), brand gradient, shadows, animations
│   ├── postcss.config.js                 Tailwind + Autoprefixer
│   ├── tsconfig.json                     strict; noUnusedLocals / noUnusedParameters; @/* path alias
│   ├── tsconfig.node.json                strict config for vite.config.ts
│   ├── vercel.json                       SPA rewrite of every path to index.html
│   ├── .gitignore                        node_modules, dist, build artifacts, local env files
│   ├── .env.example                      documented VITE_* template (API URL, bot name, language, STT mode, TTS voice)
│   ├── .env.local                        (gitignored, copy from .env.example)
│   │
│   ├── public/
│   │   ├── favicon.svg · favicon-32.png · apple-touch-icon.png · icon-192.png · icon-512.png · nexus-mark.svg
│   │   │                                 brand icons (N-as-node-graph mark)
│   │   ├── site.webmanifest              PWA manifest
│   │   └── vad/                          Silero VAD models (v5 + legacy), audio worklet and ONNX Runtime wasm/mjs
│   │                                       (11 files), served same-origin for in-browser voice detection
│   │
│   └── src/
│       ├── main.tsx                      React root (StrictMode)
│       ├── App.tsx                       router: "/" landing for signed-out visitors (signed-in → /chat); app routes → RagApp
│       ├── index.css                     ★ theme tokens (light/dark), base layers, shared utility classes
│       ├── vite-env.d.ts                 typed import.meta.env
│       │
│       ├── components/
│       │   ├── landing/
│       │   │   ├── LandingPage.tsx       marketing page at "/": pipeline, stack, demos; CTAs lead to /chat
│       │   │   ├── ProductDemo.tsx       scaled replica of the app shell playing scripted sessions, built from the
│       │   │   │                           real MessageItem / VoiceOrb / AgentAvatar components
│       │   │   └── landing.css           landing styles, all scoped under .landing
│       │   │
│       │   ├── auth/
│       │   │   ├── AuthPage.tsx          dedicated access page: renders the current gate step (sign in, then API key)
│       │   │   ├── SignInPanel.tsx       Supabase sign-in: Google, password sign-in/up, magic link, password reset/recovery
│       │   │   └── ApiKeyPanel.tsx       BYOK entry for OpenAI / Grok / Groq: provider detection by prefix, masked display
│       │   │
│       │   ├── brand/
│       │   │   └── NexusLogo.tsx         Nexus mark + wordmark (geometry matches public/favicon.svg)
│       │   │
│       │   ├── rag/                      ★ THE APP
│       │   │   ├── RagApp.tsx            ★ orchestrator: views mapped to URLs (/chat /documents /projects /voice-agents),
│       │   │   │                           access gate, wires chat + voice + speech + documents, barge-in and echo
│       │   │   │                           handling, live voice call; lazy-loads the voice-agent views
│       │   │   ├── Sidebar.tsx           new chat, conversation list (rename/delete), navigation, account + key rows; mobile drawer
│       │   │   ├── HeroSearch.tsx        empty state: time-aware greeting, hero Composer, shortcuts to documents and voices
│       │   │   ├── Conversation.tsx      scrollable thread with auto-scroll and the live voice interim bubble
│       │   │   ├── MessageItem.tsx       user/assistant turn: markdown, [n] citation chips, search activity, sources, read-aloud
│       │   │   ├── SearchActivity.tsx    per-turn retrieval timeline (live queries with timings, folds to a summary line)
│       │   │   ├── Sources.tsx           citation cards for a turn (number, title, host), collapsible
│       │   │   ├── Composer.tsx          input bar: textarea, mode chips, docs/model/speech menus, mic, send/stop,
│       │   │   │                           suggestions; "hero" | "docked" layouts
│       │   │   ├── SearchModes.tsx       Instant / Web / Deep chip group (the mode decides the agent's tools)
│       │   │   ├── SearchSuggestions.tsx autocomplete dropdown that emphasises the completion
│       │   │   ├── DocMenu.tsx           composer "Docs" chip: add, remove and select documents to ground on
│       │   │   ├── DocumentsPage.tsx     full documents view: upload, status, delete
│       │   │   ├── ModelMenu.tsx         model picker over the server's allowlist
│       │   │   ├── SpeechMenu.tsx        language, reply voice and mute behind one trigger
│       │   │   ├── LanguageMenu.tsx      conversation-language picker (what Nexus listens for and replies in)
│       │   │   ├── VoiceMenu.tsx         TTS voice popover with persona names, offline voices marked
│       │   │   ├── VoiceChatPage.tsx     live voice call screen: orb, mic/TTS toggles, tap to interrupt, mid-call pickers
│       │   │   ├── VoiceOrb.tsx          voice visualiser: rotating Fibonacci point sphere driven by mic / speech levels
│       │   │   ├── VoiceAgentsStrip.tsx  inline drawer with a dozen voice personas to preview
│       │   │   ├── VoiceAgentsPage.tsx   full voice-persona catalogue, searchable and filterable by accent
│       │   │   ├── AgentAvatar.tsx       persona avatar: gradient bubble with initial, hue stable per voice
│       │   │   └── NProjectsPage.tsx     N Projects view (/projects): short description and a way back
│       │   │
│       │   └── ui/                       Radix / shadcn-style primitives
│       │       ├── button.tsx            cva variants incl. "gradient"
│       │       └── avatar.tsx · badge.tsx · card.tsx · input.tsx · scroll-area.tsx · textarea.tsx
│       │
│       ├── hooks/
│       │   ├── useChat.ts                ★ send(text, opts); consumes the ChatEvent stream → ChatTurn state; abort,
│       │   │                               interruption truncation; conversation list synced with /conversations
│       │   ├── useVoice.ts               ★ STT pipeline: getUserMedia + Silero VAD (v5) + Web Speech + Whisper via
│       │   │                               /transcribe; loudness gate, content + prosody endpointing, barge-in
│       │   ├── useSpeech.ts              ★ TTS: SpeechSynthesis with offline-first voice ranking, streamed sentence
│       │   │                               chunks, hold/release for barge-in, speech-energy pulse
│       │   ├── useDocuments.ts           list/upload/delete for the current identity; selection of documents to ground on
│       │   ├── useAuth.ts                Supabase session mirrored into the API layer; Google, password, magic link, reset
│       │   ├── useAccessGate.ts          decides whether an action may run; collects sign-in, then key, then replays it
│       │   ├── useSuggestions.ts         debounced, abortable autocomplete fetch
│       │   ├── useTypewriter.ts          animated placeholder (reduced-motion aware)
│       │   └── useTheme.ts               light / dark / system, persisted
│       │
│       ├── assets/
│       │   ├── pulseOrb.ts               hand-authored Lottie "sonar pulse" orb
│       │   └── listeningWave.ts          generated Lottie five-bar equaliser
│       │
│       └── lib/
│           ├── api.ts                    ★ streamChat (NDJSON parser), documents, transcribe, suggestions, models,
│           │                               health/capabilities, conversations; types ChatEvent, Source, DocumentMeta; AccessError
│           ├── config.ts                 typed Vite env (API URL, names, repo links, language, STT mode, TTS voice, debug)
│           ├── supabase.ts               Supabase browser client, or null when unconfigured
│           ├── apiKey.ts                 BYOK key in localStorage; provider detection by prefix; format check, masking
│           ├── accessGate.ts             pure gate rules: sign-in before key, next step, deferral of the original action
│           ├── chatStorage.ts            per-account localStorage buckets for conversations; local/remote merge
│           ├── endpointing.ts            turn-end judgement from the transcript (complete / continuing / unclear),
│           │                               filler and stutter cleanup, prosody tie-break
│           ├── prosody.ts                pitch tracking over VAD frames → falling / rising / level contour
│           ├── voice-gate.ts             adaptive noise floor + SNR loudness gate
│           ├── echo.ts                   speaker-echo filters: assistant-echo matching and low-information barge-in rejection
│           ├── whisper-prompt.ts         Whisper initial_prompt vocabulary bias (app terms + document names)
│           ├── speech-chunk.ts           opening-clause cut so TTS starts before the first sentence completes
│           ├── stream-markdown.ts        streamed markdown: splits finished blocks for memoizing, holds back half-written syntax
│           ├── smooth-reveal.ts          paced reveal of bursty token streams (display only; speech reads the raw text)
│           ├── script-lang.ts            language detection from writing script, for TTS voice choice
│           ├── languages.ts              supported conversation languages; load/save the choice
│           ├── agents.ts                 browser TTS voices → named voice personas, greetings, ranking
│           ├── searchModes.ts            Instant / Web / Deep definitions; load/save the choice
│           ├── audio-cues.ts             Web Audio UI cues (call-end tone)
│           ├── utils.ts                  cn() class merge, date helpers
│           └── *.test.mjs                Node tests (`npm test`): accessGate · agents · apiKey · chatStorage · echo ·
│                                           endpointing · prosody · script-lang · smooth-reveal · speech-chunk · stream-markdown ·
│                                           voice-gate · whisper-prompt
│
├── .github/
│   ├── workflows/ci.yml                  CI: backend test suites, frontend typecheck + tests + build
│   ├── ISSUE_TEMPLATE/                   bug_report.yml · feature_request.yml · config.yml
│   └── pull_request_template.md          what/why, verification checklist
├── Dockerfile                            backend image (python:3.13-slim, CPU-only) for Google Cloud Run
├── .dockerignore                         keeps the image to backend code; excludes secrets and frontend
├── .gitignore                            secrets, virtualenv, node_modules, build output, local artifacts
├── requirements.txt                      backend deps: fastapi, uvicorn, openai, langchain(-openai/-qdrant), qdrant-client,
│                                           pyjwt, faster-whisper, ddgs, pypdf, python-docx, httpx, …
├── requirements-gpu.txt                  optional CUDA runtime wheels for GPU transcription
├── README.md                             overview, features, quick start, configuration
├── ARCHITECTURE.md                       how the system fits together
├── WORKFLOW.md                           ASCII end-to-end flows
├── CONTRIBUTING.md                       setup, checks to run before a PR
├── PROJECT_STRUCTURE.md                  (this file)
└── LICENSE                               MIT
```
★ = core / most-touched files.

---

## Key invariants for future edits
- **Add a capability** = new `StructuredTool` in `agent.py::build_tools`. The model decides when to call it — no regex triggers.
- **New stream signal** to the UI = new `ChatEvent` type emitted in `agent_stream` / `main.chat` and handled in `useChat` / `MessageItem` (current types: `meta`, `tool`, `delta`, `sources`, `done`, `error`).
- **`agent_stream` yields dicts** (`{type: "tool" | "delta"}`), not raw strings — the `/chat` route serialises them to NDJSON.
- **A key goes only to its own provider.** `providers.py` routes by prefix; a feature the provider lacks is unavailable rather than served with another vendor's key, and a user key is never swapped for the server's key.
- **User keys are request-scoped.** Never persisted, logged (use `credentials.redact()`), or placed in the shared model-client cache in `agent.py`; accepted only from a signed-in account.
- **Ownership comes from the verified principal** (`auth.Principal.owner_key`), never from the request body. Documents persist in Qdrant scoped per account; conversations are keyed `(owner_key, id)` in Supabase.
- **Conversation sync never blocks chat.** `conversations.py` logs and returns empty/False on failure; the client keeps its local cache.
- **Voice decision logic stays pure** in `lib/` (endpointing, prosody, voice-gate, echo, accessGate) with a matching `*.test.mjs`; hooks hold the state.
- Frontend is **strict TS with `noUnusedLocals` / `noUnusedParameters`** — keep imports and params clean (`npm run lint`).

## Run
```bash
python -m uvicorn backend.main:app --reload --port 8001    # backend, from the repo root
cd frontend && npm run dev                                 # frontend → http://localhost:5173

# tests
cd frontend && npm test && npm run lint
python -m backend.auth_test                                # likewise: credentials_test, providers_test,
                                                           # conversations_test, stt_test, identity_test, web_search_test
```
