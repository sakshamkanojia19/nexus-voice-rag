/**
 * The decision half of the access gate, as pure functions.
 *
 * Kept out of the hook so the ordering rule can be tested directly. The rule
 * that matters — **never ask for an API key before an account exists** — is a
 * security-shaped property rather than a styling preference: the server refuses
 * a key from an anonymous caller (`backend/credentials.py`), so a UI that asked
 * in the other order would be collecting a credential it then has to throw away.
 *
 * See `useAccessGate` for the state, the replay and the capability probe.
 */
import type { ServerCapabilities } from "./api";

/**
 * What the user was trying to do when the gate stopped them.
 *
 * Carrying the intent rather than just a boolean is the whole point: someone who
 * typed a question and pressed Enter should get an answer to *that question*
 * after signing in, not an empty composer and the memory of having typed it.
 */
export type AccessIntent =
  | { kind: "chat"; text: string }
  | { kind: "voice" }
  /** The chosen files ride along, so the upload actually happens after sign-in
   *  rather than leaving the user to find and drop them a second time. */
  | { kind: "upload"; files: File[] };

/** Which dialog the gate currently wants shown. */
export type GateStep = "signin" | "apikey" | null;

/** Why a page is open — which is not the same question as which one. */
export type GateRequest =
  /** The app blocked an action; the sequence decides what shows. A null intent
   *  is a refusal the server raised that we did not predict — nothing to
   *  replay, but it should still close itself once resolved. */
  | {
      source: "gate";
      intent: AccessIntent | null;
      /**
       * This request has already shown the sign-in page.
       *
       * It exists to stop the two steps running back to back. Chaining straight
       * from "signed in" into "now paste an API key" means the user never sees
       * the product between the two, so they are handing over a credential to
       * something they have still only been asked to trust. Once the account
       * exists we let them back into the app — their email in the sidebar, their
       * workspace — and collect the key on the *next* thing they do.
       */
      sawSignIn: boolean;
    }
  /** The user opened it from the sidebar, so it stays on the panel they asked
   *  for. Deriving this one would slam the key page shut the instant it
   *  opened, since a user managing a saved key is missing nothing. */
  | { source: "manual"; step: Exclude<GateStep, null> };

export interface AccessRequirements {
  /** This deployment refuses anonymous callers on the routes that matter. */
  auth: boolean;
  /** It also refuses to spend its own key, so the user must supply one. */
  apiKey: boolean;
  /** A key is only honoured from a signed-in account — so sign-in comes first. */
  keyNeedsAuth: boolean;
}

export interface GateState {
  requirements: AccessRequirements;
  signedIn: boolean;
  hasApiKey: boolean;
}

/**
 * What the server says it wants.
 *
 * `keyNeedsAuth` defaults to true when the field is absent, which is the safe
 * direction: against an older backend that doesn't report it we ask for the
 * account first and lose nothing, where guessing false would put a credential
 * prompt in front of an anonymous visitor.
 */
export function requirementsFrom(caps: ServerCapabilities | null): AccessRequirements {
  return {
    auth: caps?.auth?.required ?? false,
    apiKey: Boolean(caps?.byok?.required && caps?.byok?.accepted),
    keyNeedsAuth: caps?.byok?.requires_auth ?? true,
  };
}

export function needsAuth(s: GateState): boolean {
  return s.requirements.auth && !s.signedIn;
}

export function needsApiKey(s: GateState): boolean {
  if (!s.requirements.apiKey || s.hasApiKey) return false;
  // A key cannot be attached to an account that does not exist yet, so while
  // sign-in is outstanding the key step is not "missing" — it is unreachable.
  // The ordering therefore falls out of this condition rather than being
  // sequenced by hand somewhere, which is what stops it drifting.
  if (s.requirements.keyNeedsAuth && !s.signedIn) return false;
  return true;
}

/**
 * Everything this deployment demands has been collected.
 *
 * `known` is "the capability probe and the session lookup have both landed".
 * Absent that, nothing is satisfied — treating unknown as satisfied would let
 * the very first action of a page load through unchecked.
 */
export function isSatisfied(s: GateState, known: boolean): boolean {
  return known && !needsAuth(s) && !needsApiKey(s);
}

/** Which page to show, if any. */
export function stepFor(
  request: GateRequest | null,
  s: GateState,
  known: boolean,
): GateStep {
  if (!request) return null;
  if (request.source === "manual") return request.step;
  // Still resolving: show nothing rather than flash a page that a landing
  // capability response is about to make wrong.
  if (!known) return null;
  if (needsAuth(s)) return "signin";
  // A request that has already been through sign-in stops here. The caller
  // returns the user to the app; the key is asked for on their next action.
  if (needsApiKey(s)) return request.sawSignIn ? null : "apikey";
  return null;
}

/**
 * The account step just completed and a key is still outstanding.
 *
 * The caller's cue to close the page and hand the parked intent back, rather
 * than marching the user straight into a second demand.
 */
export function shouldDefer(request: GateRequest | null, s: GateState, known: boolean): boolean {
  if (request?.source !== "gate" || !known) return false;
  return request.sawSignIn && !needsAuth(s) && needsApiKey(s);
}
