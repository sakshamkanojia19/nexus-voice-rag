// Exercises the real src/lib/accessGate.ts: the rule that decides which door a
// user is sent to, and in what order.
//
// The property worth protecting is the ordering. The server only accepts an
// OpenAI key from a signed-in account (backend/credentials.py), so a UI that
// asked for the key first would be collecting a credential it must then refuse
// — and putting "paste your API key" in front of an unidentified visitor is the
// exact shape of the attack BYOK invites.
import {
  isSatisfied,
  needsApiKey,
  needsAuth,
  requirementsFrom,
  shouldDefer,
  stepFor,
} from "./accessGate.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

/** The deployment this project actually ships: accounts required, BYOK required. */
const STRICT = requirementsFrom({
  status: "ok",
  provider: "openai",
  auth: { supabase_configured: true, authenticated: false, required: true },
  byok: { accepted: true, required: true, requires_auth: true, server_key_available: true },
});

/** A private box: no accounts, server pays. */
const OPEN = requirementsFrom({
  status: "ok",
  provider: "openai",
  auth: { supabase_configured: false, authenticated: false, required: false },
  byok: { accepted: true, required: false, requires_auth: false, server_key_available: true },
});

const state = (requirements, signedIn, hasApiKey) => ({ requirements, signedIn, hasApiKey });
/** A freshly blocked action, before any page has been shown for it. */
const GATE = { source: "gate", intent: { kind: "chat", text: "hello" }, sawSignIn: false };
/** The same request after the user has been through the sign-in page. */
const AFTER_SIGNIN = { ...GATE, sawSignIn: true };

// ── requirementsFrom ─────────────────────────────────────────────────────────
check("strict deployment requires an account", STRICT.auth === true);
check("strict deployment requires a user key", STRICT.apiKey === true);
check("strict deployment ties the key to an account", STRICT.keyNeedsAuth === true);
check("open deployment requires nothing", OPEN.auth === false && OPEN.apiKey === false);

check(
  "an unreachable server requires nothing (no capabilities, no demands)",
  requirementsFrom(null).auth === false && requirementsFrom(null).apiKey === false,
);
check(
  "a backend that doesn't report requires_auth is assumed to need one",
  requirementsFrom({ byok: { accepted: true, required: true } }).keyNeedsAuth === true,
  "defaulting false would put a key prompt in front of an anonymous visitor",
);
check(
  "a key that is required but not accepted is not required",
  requirementsFrom({ byok: { accepted: false, required: true, requires_auth: true } }).apiKey === false,
);

// ── The ordering rule ────────────────────────────────────────────────────────
check(
  "signed out: the account is what's missing",
  needsAuth(state(STRICT, false, false)) === true,
);
check(
  "signed out: the key is NOT yet asked for",
  needsApiKey(state(STRICT, false, false)) === false,
  "asking an anonymous visitor for a credential is the thing we're preventing",
);
check(
  "signed out with a key already stored: still the account first",
  stepFor(GATE, state(STRICT, false, true), true) === "signin",
);
check(
  "signed in without a key: now the key",
  stepFor(GATE, state(STRICT, true, false), true) === "apikey",
);
check(
  "signed in with a key: nothing is shown",
  stepFor(GATE, state(STRICT, true, true), true) === null,
);
check(
  "the key step is never reachable before the account step",
  [false, true].every((hasKey) => stepFor(GATE, state(STRICT, false, hasKey), true) !== "apikey"),
);

// ── The two steps do not run back to back ────────────────────────────────────
// Signing in and then immediately being asked for an API key means the user
// never sees the product in between. They get returned to the app — signed in,
// email in the sidebar — and the key is collected on their next action.
check(
  "after signing in, the key page does NOT chain on",
  stepFor(AFTER_SIGNIN, state(STRICT, true, false), true) === null,
);
check(
  "instead the request is deferred back to the app",
  shouldDefer(AFTER_SIGNIN, state(STRICT, true, false), true) === true,
);
check(
  "a user who was ALREADY signed in goes straight to the key page",
  stepFor(GATE, state(STRICT, true, false), true) === "apikey",
  "nothing was chained, so there is nothing to decouple",
);
check(
  "and that one is not deferred",
  shouldDefer(GATE, state(STRICT, true, false), true) === false,
);
check(
  "nothing is deferred while the account is still missing",
  shouldDefer(AFTER_SIGNIN, state(STRICT, false, false), true) === false,
);
check(
  "nothing is deferred once the key is in place — that's a replay",
  shouldDefer(AFTER_SIGNIN, state(STRICT, true, true), true) === false &&
    isSatisfied(state(STRICT, true, true), true) === true,
);
check(
  "a deployment needing only an account never defers",
  shouldDefer(
    AFTER_SIGNIN,
    state({ auth: true, apiKey: false, keyNeedsAuth: true }, true, false),
    true,
  ) === false,
);
check(
  "nothing is deferred before capabilities land",
  shouldDefer(AFTER_SIGNIN, state(STRICT, true, false), false) === false,
);
check(
  "a manual request is never deferred",
  shouldDefer({ source: "manual", step: "signin" }, state(STRICT, true, false), true) === false,
);

// ── Deployments that don't demand both ───────────────────────────────────────
check(
  "an open deployment gates nothing",
  stepFor(GATE, state(OPEN, false, false), true) === null,
);
check(
  "a private box may take a key from an anonymous caller",
  needsApiKey(
    state({ auth: false, apiKey: true, keyNeedsAuth: false }, false, false),
  ) === true,
  "REQUIRE_AUTH_FOR_USER_KEY=false is the documented single-user escape hatch",
);
check(
  "accounts required but no key needed is a one-step flow",
  stepFor(GATE, state({ auth: true, apiKey: false, keyNeedsAuth: true }, false, false), true) ===
    "signin" &&
    stepFor(GATE, state({ auth: true, apiKey: false, keyNeedsAuth: true }, true, false), true) ===
      null,
);

// ── Before anything is known ─────────────────────────────────────────────────
// `known` is "the capability probe and the session lookup have both landed".
check(
  "nothing is satisfied before capabilities land",
  isSatisfied(state(OPEN, true, true), false) === false,
  "treating unknown as satisfied would let the first action of a page load through unchecked",
);
check(
  "no dialog flashes up while still resolving",
  stepFor(GATE, state(STRICT, false, false), false) === null,
);
check(
  "everything present and known is satisfied",
  isSatisfied(state(STRICT, true, true), true) === true,
);

// ── Manual opens are not derived ─────────────────────────────────────────────
// Someone managing an already-saved key is missing nothing; deriving that panel
// would close it the instant it opened.
check(
  "a manually opened key panel stays open for a fully-satisfied user",
  stepFor({ source: "manual", step: "apikey" }, state(STRICT, true, true), true) === "apikey",
);
check(
  "a manually opened sign-in panel ignores requirements too",
  stepFor({ source: "manual", step: "signin" }, state(OPEN, false, false), true) === "signin",
);
check("no request means no page", stepFor(null, state(STRICT, false, false), true) === null);

// ── Server-driven refusals ───────────────────────────────────────────────────
// A 401 we failed to predict parks a gate request with no intent: nothing to
// replay, but it must still route and still self-close.
const NO_INTENT = { source: "gate", intent: null, sawSignIn: false };
check(
  "an unpredicted refusal still routes to sign-in",
  stepFor(NO_INTENT, state(STRICT, false, false), true) === "signin",
);
check(
  "and closes itself once resolved",
  stepFor(NO_INTENT, state(STRICT, true, true), true) === null,
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
