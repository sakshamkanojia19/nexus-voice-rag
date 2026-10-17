import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { MIN_PASSWORD_LENGTH, type UseAuthReturn } from "@/hooks/useAuth";
import type { AccessIntent } from "@/lib/accessGate";

/** Google's mark, inlined — no external request, and it renders on dark. */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 1.9-1.6 4.9-4.5 6.9l6.9 5.4c4.1-3.8 6.6-9.4 6.6-15.6z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8 41.1 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z" />
      <path fill="#EA4335" d="M24 10.3c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.1 29.9 2 24 2 15.4 2 8 6.9 4.4 14.1l7.1 5.5c1.8-5.3 6.7-9.3 12.5-9.3z" />
    </svg>
  );
}

/** Good enough to gate the submit button; the server does the real validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * `signin` and `signup` take a password; `magic` and `forgot` take only an
 * email; `sent` is the shared confirmation panel; `recover` is where a reset
 * link lands.
 */
type View = "signin" | "signup" | "magic" | "forgot" | "sent" | "recover";

interface SentCopy {
  title: string;
  body: React.ReactNode;
}

interface SignInPanelProps {
  auth: UseAuthReturn;
  /** What the user was trying to do, so the page can say what it unblocks. */
  intent?: AccessIntent | null;
  /** This deployment refuses anonymous callers — so don't call it optional. */
  required?: boolean;
}

/** Why the page appeared, in the user's terms rather than the system's. */
function reasonFor(intent: AccessIntent | null | undefined): string | null {
  switch (intent?.kind) {
    case "chat":
      return "Sign in to send your question";
    case "voice":
      return "Sign in to start a voice conversation";
    case "upload":
      return "Sign in to upload documents";
    default:
      return null;
  }
}

/**
 * The sign-in form. Three ways in, because they fail differently: Google for
 * people who have it, a password for people who want the ordinary thing, and a
 * one-time link for people who would otherwise reuse a password from elsewhere.
 *
 * Chrome-free by design — it renders inside `AuthPage`, which owns the layout.
 */
export function SignInPanel({ auth, intent, required }: SignInPanelProps) {
  const [view, setView] = useState<View>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<"google" | "form" | null>(null);
  const [sentCopy, setSentCopy] = useState<SentCopy | null>(null);

  const firstFieldRef = useRef<HTMLInputElement>(null);

  const emailValid = useMemo(() => EMAIL_RE.test(email.trim()), [email]);
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
  const needsPassword = view === "signin" || view === "signup" || view === "recover";
  const canSubmit =
    view === "recover" ? passwordValid : emailValid && (!needsPassword || passwordValid);

  const { clearError } = auth;

  // A recovery link lands the user here already signed in. That view outranks
  // whatever they were doing, because until the password is set the account is
  // reachable by anyone holding the link.
  useEffect(() => {
    if (auth.recovering) setView("recover");
  }, [auth.recovering]);

  useEffect(() => {
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
  }, []);

  const go = useCallback(
    (next: View) => {
      clearError();
      setPassword("");
      setReveal(false);
      setView(next);
    },
    [clearError],
  );

  const google = useCallback(async () => {
    setBusy("google");
    await auth.signInWithGoogle();
    setBusy(null); // a successful call navigates away; failure lands back here
  }, [auth]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit || busy) return;
      setBusy("form");
      const addr = email.trim();

      if (view === "signin") {
        await auth.signInWithPassword(addr, password);
        // Success tears this page down from above, once the session lands.
      } else if (view === "signup") {
        const outcome = await auth.signUpWithPassword(addr, password);
        if (outcome === "confirm") {
          setSentCopy({
            title: "Confirm your email",
            body: (
              <>
                We sent a confirmation link to{" "}
                <span className="font-medium text-foreground">{addr}</span>. Your account
                is ready as soon as you click it.
              </>
            ),
          });
          setView("sent");
        }
      } else if (view === "magic") {
        if (await auth.signInWithEmail(addr)) {
          setSentCopy({
            title: "Check your inbox",
            body: (
              <>
                We sent a sign-in link to{" "}
                <span className="font-medium text-foreground">{addr}</span>. The link
                expires in 60 minutes and can be used once.
              </>
            ),
          });
          setView("sent");
        }
      } else if (view === "forgot") {
        if (await auth.sendPasswordReset(addr)) {
          setSentCopy({
            title: "Reset link sent",
            body: (
              <>
                If an account exists for{" "}
                <span className="font-medium text-foreground">{addr}</span>, a link to
                choose a new password is on its way.
              </>
            ),
          });
          setView("sent");
        }
      } else if (view === "recover") {
        await auth.updatePassword(password);
      }

      setBusy(null);
    },
    [auth, busy, canSubmit, email, password, view],
  );

  const reason = reasonFor(intent);

  const heading =
    view === "signup"
      ? "Create your account"
      : view === "forgot"
        ? "Reset your password"
        : view === "magic"
          ? "Sign in with a link"
          : view === "recover"
            ? "Choose a new password"
            : reason ?? "Sign in to your account";

  const subheading =
    view === "signup"
      ? "Your documents and conversations stay with the account, on every device."
      : view === "forgot"
        ? "Enter your email and we'll send you a link to set a new one."
        : view === "magic"
          ? "No password needed — we'll email you a one-time link."
          : view === "recover"
            ? `At least ${MIN_PASSWORD_LENGTH} characters. This replaces your old password everywhere.`
            : required
              ? `${config.botName} answers under your own account, so every request is yours.`
              : "Continue with Google, an email link, or your password.";

  const fieldClass = "auth-field";
  const linkClass = "auth-link auth-focus";

  if (view === "sent" && sentCopy) {
    return (
      <div>
        <div className="flex size-11 items-center justify-center rounded-full border border-success/25 bg-success/10">
          <MailCheck className="size-5 text-success" />
        </div>
        <h1 id="auth-title" className="mt-5 text-[1.375rem] font-semibold tracking-tight">
          {sentCopy.title}
        </h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground" aria-live="polite">
          {sentCopy.body}
        </p>
        <button onClick={() => go("signin")} className={cn(linkClass, "mt-7 inline-flex items-center gap-1.5")}>
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </button>
        {auth.error ? <ErrorNote message={auth.error} /> : null}
      </div>
    );
  }

  return (
    <div>
      <h1 id="auth-title" className="text-[1.375rem] font-semibold tracking-tight">
        {heading}
      </h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{subheading}</p>

      {view !== "recover" ? (
        <>
          <button
            onClick={google}
            disabled={busy !== null}
            className="auth-btn auth-btn-secondary auth-focus mt-6"
          >
            {busy === "google" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <GoogleMark className="size-[18px]" />
            )}
            Continue with Google
          </button>

          <div className="my-5 flex items-center gap-4">
            <span className="h-px flex-1 bg-white/[0.08]" />
            <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
              or
            </span>
            <span className="h-px flex-1 bg-white/[0.08]" />
          </div>
        </>
      ) : null}

      <form onSubmit={submit} noValidate className={view === "recover" ? "mt-7" : undefined}>
        {view !== "recover" ? (
          <>
            <label htmlFor="auth-email" className="block text-[13px] font-medium text-foreground/85">
              Email address
            </label>
            <input
              ref={firstFieldRef}
              id="auth-email"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={cn(fieldClass, "mt-2")}
            />
          </>
        ) : null}

        {needsPassword ? (
          <>
            <div className={cn("flex items-baseline justify-between", view === "recover" ? "" : "mt-4")}>
              <label htmlFor="auth-password" className="block text-[13px] font-medium text-foreground/85">
                {view === "signin" ? "Password" : "New password"}
              </label>
              {view === "signin" ? (
                <button type="button" onClick={() => go("forgot")} className={cn(linkClass, "text-[12px]")}>
                  Forgot?
                </button>
              ) : null}
            </div>
            <div className="relative mt-2">
              <input
                ref={view === "recover" ? firstFieldRef : undefined}
                id="auth-password"
                type={reveal ? "text" : "password"}
                name="password"
                autoComplete={view === "signin" ? "current-password" : "new-password"}
                spellCheck={false}
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={view === "signin" ? "Your password" : `At least ${MIN_PASSWORD_LENGTH} characters`}
                className={cn(fieldClass, "pr-11")}
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "Hide password" : "Show password"}
                className={cn(
                  "auth-focus absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5",
                  "text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground",
                )}
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {/* Only once there is enough typed to judge — an error on the first
                keystroke is noise, not guidance. */}
            {view !== "signin" && password.length > 0 && !passwordValid ? (
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {MIN_PASSWORD_LENGTH - password.length} more character
                {MIN_PASSWORD_LENGTH - password.length === 1 ? "" : "s"} needed.
              </p>
            ) : null}
          </>
        ) : null}

        <button
          type="submit"
          disabled={busy !== null || !canSubmit}
          className={cn(
            "mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl",
            "bg-[hsl(258_72%_58%)] text-sm font-semibold text-white",
            "transition-colors hover:bg-[hsl(258_72%_52%)] active:bg-[hsl(258_72%_48%)]",
            "disabled:cursor-not-allowed disabled:bg-white/[0.07] disabled:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(240_5%_9%)]",
          )}
        >
          {busy === "form" ? <Loader2 className="size-4 animate-spin" /> : null}
          {view === "signup"
            ? "Create account"
            : view === "forgot"
              ? "Send reset link"
              : view === "magic"
                ? "Email me a sign-in link"
                : view === "recover"
                  ? "Set new password"
                  : "Sign in"}
        </button>
      </form>

      {view === "signin" ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <button onClick={() => go("magic")} className={linkClass}>
            Email me a link instead
          </button>
          <button onClick={() => go("signup")} className={linkClass}>
            Create an account
          </button>
        </div>
      ) : null}

      {view === "signup" || view === "forgot" || view === "magic" ? (
        <button onClick={() => go("signin")} className={cn(linkClass, "mt-5 inline-flex items-center gap-1.5")}>
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </button>
      ) : null}

      {auth.error ? <ErrorNote message={auth.error} /> : null}

    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-[13px] leading-relaxed text-destructive"
    >
      {message}
    </p>
  );
}
