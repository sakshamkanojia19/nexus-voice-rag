import { useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { NexusLogo } from "@/components/brand/NexusLogo";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { UseAuthReturn } from "@/hooks/useAuth";
import type { AccessIntent, AccessRequirements, GateStep } from "@/lib/accessGate";
import { SignInPanel } from "./SignInPanel";
import { ApiKeyPanel } from "./ApiKeyPanel";

interface AuthPageProps {
  /** Which step to render. The caller only renders this page when non-null. */
  step: Exclude<GateStep, null>;
  auth: UseAuthReturn;
  requirements: AccessRequirements;
  /** What the user was trying to do when they were sent here. */
  intent: AccessIntent | null;
  /** The server demands accounts but this build has no identity provider, so
   *  no form here can succeed. Say so instead of pretending. */
  misconfigured?: boolean;
  /** Leave without finishing — the app underneath is still usable. */
  onBack: () => void;
  onKeySaved: (key: string | null) => void;
}

/**
 * The dedicated page users land on to authenticate.
 *
 * ── Why this looks the way it does ─────────────────────────────────────────
 *
 * Earlier versions of this file were a split panel: product pitch on the left,
 * form on the right, serif display type, gradient wordmark, icon tiles, value
 * bullets. It was wrong, and the failure is worth writing down because the
 * instinct that produced it is a common one — when a screen feels unfinished,
 * add design.
 *
 * The pattern the serious tools converged on is the opposite. Stripe, Vercel,
 * Linear, Notion and Framer all ship a single centred column around 400px, on
 * a near-plain background, with one accent button and almost no prose. The
 * marketing panel is a 2019 template, and it reads as one — which on a page
 * asking for a credential is actively expensive, because "looks generated"
 * and "looks like a phishing clone" are neighbours.
 *
 * So the rules here are subtractive:
 *
 *   - One column, centred, 400px. No aside, no pitch — the user has already
 *     chosen to use the product; selling to them now is noise.
 *   - Inter throughout. The serif display face belongs on the hero, not here;
 *     mixing it with a gradient wordmark was the single most "AI-generated"
 *     signal on the page.
 *   - One saturated element per view: the submit button. Everything else is a
 *     neutral and a hairline.
 *   - Detail lives behind a disclosure, not in a wall of bullets. It stays
 *     checkable without being shouted.
 *
 * The app stays mounted behind this. `onBack` returns to it: the gate is soft.
 */
export function AuthPage({
  step,
  auth,
  requirements,
  intent,
  misconfigured,
  onBack,
  onKeySaved,
}: AuthPageProps) {
  const reduceMotion = useReducedMotion();

  // Escape leaves. A full page with no keyboard way out is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // This page owns the viewport while it is up.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-[hsl(var(--auth-bg))]"
    >
      {/* One faint wash, top-centre. Just enough that the background isn't a
          flat black rectangle — deliberately far short of a gradient feature. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(60rem 30rem at 50% -8%, hsl(258 40% 22% / 0.4), transparent 70%)",
        }}
      />

      <header className="relative flex items-center justify-between gap-3 px-5 py-5 sm:px-7">
        <div className="flex items-center gap-2">
          <NexusLogo className="size-7 rounded-lg" />
          <span className="text-[14px] font-semibold lowercase tracking-tight text-foreground/90">
            {config.appName}
          </span>
        </div>
        <button
          onClick={onBack}
          className="auth-link auth-focus inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-white/[0.05]"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </button>
      </header>

      <main className="relative flex flex-1 items-start justify-center px-5 pb-12 pt-[7vh] sm:pt-[10vh]">
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[400px]"
        >
          {misconfigured ? (
            <div>
              <span className="grid size-10 place-items-center rounded-lg border border-destructive/25 bg-destructive/10">
                <ShieldAlert className="size-5 text-destructive" aria-hidden />
              </span>
              <h1 id="auth-title" className="mt-5 text-[1.375rem] font-semibold tracking-tight">
                Sign-in isn&apos;t available
              </h1>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                This server requires an account, but this build has no identity provider
                configured — nothing on this page would work.
              </p>
              <p className="mt-4 rounded-lg border border-[hsl(var(--auth-line))] bg-white/[0.02] px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground">
                Set <code className="font-mono text-foreground">VITE_SUPABASE_URL</code> and{" "}
                <code className="font-mono text-foreground">VITE_SUPABASE_ANON_KEY</code> in{" "}
                <code className="font-mono text-foreground">frontend/.env.local</code>, or turn{" "}
                <code className="font-mono text-foreground">REQUIRE_AUTH</code> off on the server.
              </p>
            </div>
          ) : step === "signin" ? (
            <SignInPanel auth={auth} intent={intent} required={requirements.auth} />
          ) : (
            <ApiKeyPanel
              required={requirements.apiKey}
              accountEmail={auth.user?.email ?? null}
              intent={intent}
              onSaved={onKeySaved}
            />
          )}
        </motion.div>
      </main>

      {/* A quiet footer line instead of a paragraph inside the form. It is the
          kind of thing people look for to confirm a page is the real product,
          and it costs one row to provide. In the flow rather than pinned to the
          viewport: a tall panel (provider picker + the key details opened)
          must push it down, not run over it. */}
      <p
        className={cn(
          "pointer-events-none relative shrink-0 px-5 pb-6 text-center",
          "text-[11.5px] text-muted-foreground/45",
        )}
      >
        {config.appName} · your documents and usage stay scoped to your account
      </p>
    </motion.div>
  );
}
