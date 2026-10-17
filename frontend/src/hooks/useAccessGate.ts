import { useCallback, useEffect, useRef, useState } from "react";
import { healthCheck, type ServerCapabilities } from "@/lib/api";
import { detectProvider, loadApiKey, type ProviderId } from "@/lib/apiKey";
import { debugLog } from "@/lib/config";
import {
  isSatisfied,
  needsApiKey,
  needsAuth,
  requirementsFrom,
  shouldDefer,
  stepFor,
  type AccessIntent,
  type AccessRequirements,
  type GateRequest,
  type GateState,
  type GateStep,
} from "@/lib/accessGate";
import type { UseAuthReturn } from "./useAuth";

export type { AccessIntent, AccessRequirements, GateStep } from "@/lib/accessGate";

export interface UseAccessGateReturn {
  /** Null until /health answers. The UI shows nothing gate-related until then. */
  caps: ServerCapabilities | null;
  requirements: AccessRequirements;
  hasApiKey: boolean;
  /** Whose key is saved. Requests run on that provider, so its model list applies. */
  keyProvider: ProviderId | null;
  step: GateStep;
  /** The blocked action, so dialog copy can say what it is unblocking. */
  pending: AccessIntent | null;
  /** Everything this deployment demands is satisfied. */
  ready: boolean;
  /**
   * The server wants accounts but the browser has no Supabase project wired up,
   * so there is no way in. Worth saying out loud rather than looping the user
   * through a dialog that cannot succeed.
   */
  misconfigured: boolean;
  /** True when the action may run right now. False means a step was opened. */
  gate: (intent: AccessIntent) => boolean;
  openSignIn: () => void;
  openApiKey: () => void;
  close: () => void;
  /** Re-read the stored key after the dialog saves or clears one. */
  refreshApiKey: () => void;
  /** For a refusal that arrived from the server rather than being predicted. */
  handleAccessError: (reason: "signin" | "apikey") => void;
}

function storedKeyProvider(): ProviderId | null {
  return detectProvider(loadApiKey())?.id ?? null;
}

interface Options {
  auth: UseAuthReturn;
  /** Replays the intent once every requirement is met. */
  onSatisfied: (intent: AccessIntent) => void;
  /**
   * Sign-in finished but a key is still needed, so the user is being returned
   * to the app rather than marched into a second demand. The intent is handed
   * back unrun — put the question back in the composer.
   */
  onDeferred?: (intent: AccessIntent | null) => void;
}

/**
 * The single place that decides whether an action is allowed to run.
 *
 * The rule this encodes: **the app loads for everyone, and asks for an identity
 * at the moment it needs one.** Nobody is met by a credential prompt on a page
 * they have not used yet — the hero, the sidebar and the document list all
 * render anonymously — but the first action that spends money or touches stored
 * data collects an account, then a key, then does the thing the user asked for.
 *
 * Which dialog shows is *derived* from what is still missing, so the sequence is
 * self-closing: signing in advances to the key step, and saving the key closes
 * everything and replays the original action. No call site has to know that
 * sequence exists, and nothing has to remember to close anything.
 *
 * The server enforces all of this independently and returns 401/402. This hook
 * exists so the user finds out *before* typing into a dead composer, not to be
 * the enforcement. The decision logic itself lives in `lib/accessGate.ts`.
 */
export function useAccessGate({ auth, onSatisfied, onDeferred }: Options): UseAccessGateReturn {
  const [caps, setCaps] = useState<ServerCapabilities | null>(null);
  const [keyProvider, setKeyProvider] = useState(storedKeyProvider);
  const hasApiKey = keyProvider !== null;
  const [request, setRequest] = useState<GateRequest | null>(null);

  // Held in a ref so replaying an intent doesn't depend on the identity of a
  // callback the caller redefines every render.
  const onSatisfiedRef = useRef(onSatisfied);
  onSatisfiedRef.current = onSatisfied;
  const onDeferredRef = useRef(onDeferred);
  onDeferredRef.current = onDeferred;

  useEffect(() => {
    let cancelled = false;
    void healthCheck()
      .then((h) => { if (!cancelled) setCaps(h); })
      .catch((e) => debugLog("capabilities unavailable", e));
    return () => { cancelled = true; };
  }, []);

  const requirements = requirementsFrom(caps);
  const state: GateState = { requirements, signedIn: auth.user !== null, hasApiKey };

  // "The capability probe and the session lookup have both landed."
  const known = caps !== null && auth.ready;

  const step = stepFor(request, state, known);
  const pending = request?.source === "gate" ? request.intent : null;
  const ready = isSatisfied(state, known);
  const misconfigured = requirements.auth && !auth.enabled;

  const refreshApiKey = useCallback(() => setKeyProvider(storedKeyProvider()), []);

  const gate = useCallback(
    (intent: AccessIntent): boolean => {
      if (isSatisfied(state, known)) return true;
      // Not allowed yet, or not yet knowable. Either way the intent is parked;
      // `step` opens the right dialog, and the effect below replays it once
      // there is nothing left to collect.
      setRequest({ source: "gate", intent, sawSignIn: false });
      return false;
    },
    // `state` is rebuilt every render, so depend on its contents rather than
    // its identity — otherwise this callback changes on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [known, needsAuth(state), needsApiKey(state)],
  );

  // Remember that this request has been through the sign-in page, so that
  // finishing it releases the user back to the app instead of chaining.
  useEffect(() => {
    if (request?.source !== "gate" || request.sawSignIn) return;
    if (step === "signin") setRequest({ ...request, sawSignIn: true });
  }, [request, step]);

  // Replay: a gate request with nothing left to collect. Or defer: the account
  // step just landed and only the key is outstanding.
  useEffect(() => {
    if (request?.source !== "gate") return;
    // A recovery link signs the user in so they can set a new password. They
    // are not finished with the page yet, so don't fire underneath it.
    if (auth.recovering) return;

    if (shouldDefer(request, state, known)) {
      const { intent } = request;
      setRequest(null);
      debugLog("account step done; deferring the key until the next action");
      onDeferredRef.current?.(intent);
      return;
    }

    if (!isSatisfied(state, known)) return;

    const { intent } = request;
    setRequest(null);
    if (intent) {
      debugLog("access gate satisfied; replaying", intent.kind);
      onSatisfiedRef.current(intent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, known, needsAuth(state), needsApiKey(state), auth.recovering]);

  // A sign-in the user started themselves, from the sidebar. Nothing is waiting
  // on it, so nothing else would ever take the dialog down.
  useEffect(() => {
    if (request?.source !== "manual" || request.step !== "signin") return;
    if (auth.user && !auth.recovering) setRequest(null);
  }, [request, auth.user, auth.recovering]);

  const openSignIn = useCallback(() => setRequest({ source: "manual", step: "signin" }), []);
  const openApiKey = useCallback(() => setRequest({ source: "manual", step: "apikey" }), []);

  const close = useCallback(() => {
    // Dismissing abandons the action. Keeping it parked would fire it later at
    // a moment the user has stopped expecting anything to happen.
    setRequest(null);
  }, []);

  // A refusal we failed to predict — a session that expired mid-flight, or a
  // deployment whose flags changed under us. Park a gate request carrying no
  // intent: the turn that just failed isn't worth replaying, but routing it
  // through the same machinery means the dialog closes itself once the user has
  // fixed whatever the server complained about. Re-probe too, rather than keep
  // trusting capabilities cached at boot — they are what mispredicted this.
  const handleAccessError = useCallback((_reason: "signin" | "apikey") => {
    setRequest({ source: "gate", intent: null, sawSignIn: false });
    void healthCheck().then(setCaps).catch(() => {});
  }, []);

  return {
    caps,
    requirements,
    hasApiKey,
    keyProvider,
    step,
    pending,
    ready,
    misconfigured,
    gate,
    openSignIn,
    openApiKey,
    close,
    refreshApiKey,
    handleAccessError,
  };
}
