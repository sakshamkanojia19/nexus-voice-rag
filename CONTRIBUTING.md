# Contributing to Nexus

Thanks for taking a look. Issues and PRs are both welcome — including "this
confused me," which is a legitimate bug report for a project that lives or dies
by whether strangers can run it.

## Getting set up

Follow [Quick start](README.md#-quick-start) in the README. A GPU is optional;
everything runs on CPU with the `base` Whisper model, just slower.

You need two things that cost nothing: a free [Qdrant Cloud](https://cloud.qdrant.io)
cluster and an OpenAI API key. Without Qdrant, document search degrades
gracefully and chat plus voice still work — enough to develop against.

## Before you open a PR

```powershell
cd frontend && npm test && npm run lint    # lint is tsc --noEmit, strict
python -m backend.stt_test
python -m backend.identity_test
python -m backend.credentials_test
python -m backend.providers_test
python -m backend.auth_test
python -m backend.conversations_test
python -m backend.web_search_test
```

All of it must pass. `npm run lint` is not advisory — the frontend is strict TS
and a type error is a broken build on Vercel.

## Ground rules from the codebase

These are conventions the code already follows, not preferences. A PR that
breaks one will get a comment asking about it.

**New capability means a new `StructuredTool` in `agent.py` — never a regex.**
Tool choice belongs to the model. The moment you add `if "search" in query`,
you have two systems deciding what to do and they will disagree. This is the
single most important rule here.

**Voice-pipeline logic goes in pure modules under `frontend/src/lib/`, with a
`.test.mjs` beside it.** No React imports, no DOM, no network. That is what
makes turn-taking testable at all — `endpointing.ts` is decidable from a
transcript and a timestamp, so its tests run in Node in milliseconds.

**Test cases come from real captured failures.** The existing suites use actual
console transcripts from sessions that went wrong, not invented inputs. If you
fix a voice bug, the transcript that exposed it is the test case.

**Comments explain why, not what.** This codebase records the reasoning behind
decisions — the tradeoff considered, the cost of the alternative. Match that.
If you change code that a comment describes, update the comment in the same
commit; a stale comment is a bug, because people trust it.

**Nothing degrades into a hard failure.** Qdrant down means document search is
unavailable and everything else keeps working. CUDA broken means the model
ladder falls to CPU. Follow that pattern — voice never dies.

## Security

Never log, store, or echo a user's API key. `credentials.py` redacts keys from
errors on purpose; keep that intact. If you find a way to leak one, please
report it privately rather than opening a public issue.

## Licensing your contribution

Nexus is [MIT licensed](LICENSE). By opening a PR you confirm the work is
yours to give, and you agree that it is licensed under the same MIT terms.
You keep the copyright in your own work.

## Commit messages

Explain why the change was needed, not just what changed. Same standard as the
comments.
