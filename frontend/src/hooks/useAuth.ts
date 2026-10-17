import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { setAccessToken } from "@/lib/api";
import { debugLog } from "@/lib/config";
import { supabase, supabaseEnabled } from "@/lib/supabase";

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** What a password sign-up did, so the caller knows which panel to show next. */
export type SignUpOutcome =
  /** Confirmations are off — a session exists and the user is already in. */
  | "session"
  /** Confirmations are on — nothing happens until they click the email. */
  | "confirm"
  | "error";

export interface UseAuthReturn {
  enabled: boolean;
  /** Null until the initial session lookup resolves — avoids a sign-in flash. */
  ready: boolean;
  user: AuthUser | null;
  /**
   * True when this page load came from a password-reset link. Supabase signs the
   * user in to let them set a new password, so `user` is populated and the app
   * would otherwise look normally signed in — this is what tells the UI to ask
   * for the new password instead.
   */
  recovering: boolean;
  signInWithGoogle: () => Promise<void>;
  /** Passwordless email link. Resolves once the mail is sent, not once clicked. */
  signInWithEmail: (email: string) => Promise<boolean>;
  signInWithPassword: (email: string, password: string) => Promise<boolean>;
  signUpWithPassword: (email: string, password: string) => Promise<SignUpOutcome>;
  sendPasswordReset: (email: string) => Promise<boolean>;
  /** Completes a recovery: sets the new password on the current session. */
  updatePassword: (password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  error: string | null;
  clearError: () => void;
}

/** Supabase's own floor is 6. Eight is the smallest length worth calling a
 *  policy, and matching it here means the failure shows up before a round trip. */
export const MIN_PASSWORD_LENGTH = 8;

function toUser(session: Session | null): AuthUser | null {
  if (!session?.user) return null;
  const meta = session.user.user_metadata ?? {};
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    name: (meta.full_name as string) || (meta.name as string) || null,
    avatarUrl: (meta.avatar_url as string) || (meta.picture as string) || null,
  };
}

/**
 * Turn Supabase's wording into something a user can act on.
 *
 * Only the messages whose raw form actively misleads are rewritten. In
 * particular "Invalid login credentials" is returned for a wrong password AND
 * for an email that has no account at all — deliberately, so the endpoint can't
 * be used to enumerate who has signed up. The replacement has to preserve that
 * ambiguity rather than resolve it.
 */
function humanize(message: string): string {
  if (/invalid login credentials/i.test(message)) {
    return "That email and password don't match an account.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Confirm your email first — check your inbox for the link we sent.";
  }
  if (/user already registered|already been registered/i.test(message)) {
    return "An account already exists for that email. Sign in instead.";
  }
  if (/provider is not enabled/i.test(message)) {
    return "Google sign-in isn't enabled on this Supabase project yet.";
  }
  if (/for security purposes|rate limit|too many requests/i.test(message)) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (/password should be at least/i.test(message)) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return message;
}

/** Which way the identity moved. Callers clear different things for each. */
export type IdentityChange = "SIGNED_IN" | "SIGNED_OUT";

/**
 * Supabase session, mirrored into the API layer.
 *
 * The important side effect is `setAccessToken`: every request the app makes
 * carries whatever token is current, so the backend derives ownership from a
 * verified identity rather than anything the page could forge. On sign-out the
 * token is cleared and the backend falls back to the anonymous cookie.
 *
 * Identity is now load-bearing rather than cosmetic — the server will not spend
 * a key, its own or the user's, for a caller it cannot name — so this hook
 * carries all three ways in: Google, a one-time email link, and a password.
 */
export function useAuth(onIdentityChange?: (event: IdentityChange) => void): UseAuthReturn {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(!supabaseEnabled);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref and refreshed every render. The subscription below is set up
  // once, so reading the callback from props would freeze it at whatever the
  // first render passed — and this callback is what wipes the previous user's
  // conversations and API key, which must never run against stale bindings.
  const onIdentityChangeRef = useRef(onIdentityChange);
  onIdentityChangeRef.current = onIdentityChange;

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setAccessToken(data.session?.access_token ?? null);
      setUser(toUser(data.session));
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      debugLog("auth:", event, session?.user?.email ?? "(anonymous)");
      setAccessToken(session?.access_token ?? null);
      setUser(toUser(session));
      setReady(true);
      // Arriving from a reset link. The session is real, so every other part of
      // the app would treat this as an ordinary sign-in; the flag is what keeps
      // the dialog open long enough to actually change the password.
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_OUT") setRecovering(false);
      // Signing in or out changes the owner key on both sides, so everything
      // scoped to it — documents, conversations, the stored API key — has to be
      // refetched or dropped.
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
        onIdentityChangeRef.current?.(event);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // Deliberately mounts once; the callback is read from a ref so it stays
    // current without re-subscribing (which would thrash the listener).
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return;
    setError(null);
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    // A success navigates away, so reaching the next line at all means failure.
    if (e) setError(humanize(e.message));
  }, []);

  const signInWithEmail = useCallback(async (email: string) => {
    if (!supabase) return false;
    setError(null);
    const { error: e } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (e) {
      setError(humanize(e.message));
      return false;
    }
    return true;
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    if (!supabase) return false;
    setError(null);
    const { error: e } = await supabase.auth.signInWithPassword({ email, password });
    if (e) {
      setError(humanize(e.message));
      return false;
    }
    return true; // onAuthStateChange delivers the session
  }, []);

  const signUpWithPassword = useCallback(
    async (email: string, password: string): Promise<SignUpOutcome> => {
      if (!supabase) return "error";
      setError(null);
      const { data, error: e } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (e) {
        setError(humanize(e.message));
        return "error";
      }
      // With confirmations enabled Supabase returns a user but no session, and
      // — to avoid leaking which addresses are registered — it returns that same
      // shape for an email that already has an account. So "check your inbox"
      // is the honest thing to say either way; it is true in both cases.
      return data.session ? "session" : "confirm";
    },
    [],
  );

  const sendPasswordReset = useCallback(async (email: string) => {
    if (!supabase) return false;
    setError(null);
    const { error: e } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (e) {
      setError(humanize(e.message));
      return false;
    }
    return true;
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    if (!supabase) return false;
    setError(null);
    const { error: e } = await supabase.auth.updateUser({ password });
    if (e) {
      setError(humanize(e.message));
      return false;
    }
    setRecovering(false);
    return true;
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    setError(null);
    const { error: e } = await supabase.auth.signOut();
    if (e) setError(humanize(e.message));
  }, []);

  return {
    enabled: supabaseEnabled,
    ready,
    user,
    recovering,
    signInWithGoogle,
    signInWithEmail,
    signInWithPassword,
    signUpWithPassword,
    sendPasswordReset,
    updatePassword,
    signOut,
    error,
    clearError,
  };
}
