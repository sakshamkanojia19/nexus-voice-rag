## What and why

<!-- What changes, and what problem it solves. The "why" matters more than the
     "what" — the diff already shows what. -->

## How it was verified

<!-- For voice changes, say what you actually said out loud and what happened.
     Unit tests do not catch turn-taking regressions; ears do. -->

- [ ] `cd frontend && npm test && npm run lint`
- [ ] Backend suites pass (`python -m backend.stt_test`, etc. — see CONTRIBUTING.md)
- [ ] Tested by voice, if this touches the voice pipeline

## Checklist

- [ ] New capability is a `StructuredTool` in `agent.py`, not a regex trigger
- [ ] New voice logic is a pure module in `lib/` with a `.test.mjs` beside it
- [ ] Comments explain *why*; any comment describing changed code is updated
- [ ] No API key is logged, stored, or echoed
- [ ] I agree to license this contribution as described under "Licensing your contribution" in CONTRIBUTING.md
