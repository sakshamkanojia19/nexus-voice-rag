import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, ExternalLink, Eye, EyeOff, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import {
  KEY_PROVIDERS,
  detectProvider,
  isValidKeyFormat,
  loadApiKey,
  maskKey,
  saveApiKey,
  type ProviderId,
} from "@/lib/apiKey";
import type { AccessIntent } from "@/lib/accessGate";

/** How each provider is presented. Capability notes are the honest ones: only
 *  OpenAI can embed documents, so it is the only card that promises them. */
const PROVIDER_COPY: Record<ProviderId, { name: string; sub: string; detail: string }> = {
  openai: { name: "OpenAI", sub: "GPT-4o", detail: "Every feature, including uploading and searching your documents." },
  xai: { name: "Grok", sub: "by xAI", detail: "Chat, web search and voice. Uploading documents needs an OpenAI key." },
  groq: { name: "Groq", sub: "gpt-oss", detail: "Very fast replies for chat, web search and voice. Uploading documents needs an OpenAI key." },
};

interface ApiKeyPanelProps {
  /** Fired after a save or a clear, so callers can retry whatever was refused. */
  onSaved?: (key: string | null) => void;
  /** True when this deployment will not answer without a caller-supplied key. */
  required?: boolean;
  /** The signed-in account this key will be used under. */
  accountEmail?: string | null;
  /** What the user was trying to do when this appeared. */
  intent?: AccessIntent | null;
}

/**
 * Where a user provides their own OpenAI, xAI (Grok) or Groq key. Which one it
 * is comes from the key itself, so there is no provider picker to get wrong.
 *
 * The hard part is not the form, it is the tone. "Paste your API key here" is
 * the shape of a phishing prompt, and the instinct is to compensate with
 * reassurance — badges, bullet lists, paragraphs about encryption. That backfires
 * twice: it makes the page longer than the task, and over-explaining is itself
 * something a fraudulent page does. Real developer tools ask for a key in about
 * four lines and let the detail sit one click away.
 *
 * So the trust work is carried by structure rather than volume:
 *
 *  - **It is never the first thing anyone sees.** The server only accepts a key
 *    from a signed-in account, so by the time this renders the user has one and
 *    knows whose page they are on.
 *  - **It names the account.** A page that isn't ours doesn't know who you are.
 *  - **The specifics are one disclosure away** — present and checkable, not
 *    shouted. A `<details>` element, so it works without JavaScript state and
 *    is keyboard-operable for free.
 */
export function ApiKeyPanel({ onSaved, required, accountEmail, intent }: ApiKeyPanelProps) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState<string | null>(() => loadApiKey());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
  }, []);

  const trimmed = value.trim();
  // Only complain once there is enough input to judge — validating every
  // keystroke shows an error before the user has finished the first word.
  const malformed = trimmed.length > 8 && !isValidKeyFormat(trimmed);
  const detected = detectProvider(trimmed);
  const savedProvider = detectProvider(saved);

  // The picker sets expectations (placeholder, where to get a key, what works);
  // the key itself is still the authority — the server routes by its prefix.
  // So a pasted key from another provider moves the picker rather than being
  // refused for "not matching" a choice the user made two seconds earlier.
  const [choice, setChoice] = useState<ProviderId>(() => savedProvider?.id ?? "openai");
  useEffect(() => {
    if (detected) setChoice(detected.id);
  }, [detected]); // KEY_PROVIDERS entries, so the reference is stable
  const chosen = KEY_PROVIDERS.find((p) => p.id === choice) ?? KEY_PROVIDERS[0];
  const copy = PROVIDER_COPY[chosen.id];

  const pick = (id: ProviderId) => {
    setChoice(id);
    inputRef.current?.focus();
  };
  // Arrow keys move through the group, as in any native radio group.
  const onPickerKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = KEY_PROVIDERS.findIndex((p) => p.id === choice);
    const next = KEY_PROVIDERS[(i + step + KEY_PROVIDERS.length) % KEY_PROVIDERS.length];
    setChoice(next.id);
    document.getElementById(`provider-${next.id}`)?.focus();
  };

  const save = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const key = value.trim();
      if (!isValidKeyFormat(key)) return;
      saveApiKey(key);
      setSaved(key);
      setValue("");
      onSaved?.(key);
    },
    [onSaved, value],
  );

  const clear = useCallback(() => {
    saveApiKey(null);
    setSaved(null);
    setValue("");
    onSaved?.(null);
  }, [onSaved]);

  return (
    <div>
      <h1 id="auth-title" className="text-[1.375rem] font-semibold tracking-tight">
        Add your API key
      </h1>
      {/* One sentence. The honest reason, which is also the short one. */}
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        {required
          ? `${config.botName} runs on your own OpenAI, xAI (Grok) or Groq account — billed to you at their prices, with nothing added.`
          : `Use your own OpenAI, xAI (Grok) or Groq account so usage bills to you rather than ${config.botName}.`}
      </p>

      <form onSubmit={save} className="mt-6">
        <p id="provider-label" className="mb-2 text-[13px] font-medium text-foreground/85">
          Provider
        </p>
        <div
          role="radiogroup"
          aria-labelledby="provider-label"
          onKeyDown={onPickerKey}
          className="grid grid-cols-3 gap-2"
        >
          {KEY_PROVIDERS.map((p) => {
            const selected = p.id === choice;
            const c = PROVIDER_COPY[p.id];
            return (
              <button
                key={p.id}
                id={`provider-${p.id}`}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => pick(p.id)}
                className={cn(
                  "auth-focus relative flex flex-col items-start rounded-xl border px-3 py-2.5 text-left transition-colors",
                  selected
                    ? "border-[hsl(var(--auth-accent)/0.6)] bg-[hsl(var(--auth-accent)/0.1)]"
                    : "border-[hsl(var(--auth-line))] bg-white/[0.02] hover:border-[hsl(var(--auth-line-strong))] hover:bg-white/[0.04]",
                )}
              >
                <span className="text-[13.5px] font-semibold text-foreground">{c.name}</span>
                <span className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{c.sub}</span>
                <span
                  aria-hidden
                  className={cn(
                    "absolute right-2 top-2 flex size-4 items-center justify-center rounded-full border transition-colors",
                    selected
                      ? "border-transparent bg-[hsl(var(--auth-accent))] text-white"
                      : "border-[hsl(var(--auth-line-strong))]",
                  )}
                >
                  {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                </span>
              </button>
            );
          })}
        </div>
        <p id="provider-detail" className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {copy.detail}
        </p>

        <div className="mb-2 mt-5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <label htmlFor="api-key" className="text-[13px] font-medium text-foreground/85">
            {saved ? `Replace with a ${copy.name} key` : `Your ${copy.name} key`}
          </label>
          <a
            href={chosen.keysUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="auth-focus inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Get your {copy.name} key <ExternalLink className="size-3" />
          </a>
        </div>

        <div className="relative">
          <input
            ref={inputRef}
            id="api-key"
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`${chosen.prefix}…`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={malformed || undefined}
            aria-describedby={malformed ? "api-key-error" : "provider-detail"}
            className="auth-field pr-10 font-mono text-[13px] placeholder:font-sans placeholder:text-[13.5px]"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide key" : "Show key"}
            className={cn(
              "auth-focus absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5",
              "text-muted-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-foreground",
            )}
          >
            {reveal ? <EyeOff className="size-[15px] " /> : <Eye className="size-[15px]" />}
          </button>
        </div>

        {malformed ? (
          <p id="api-key-error" role="alert" className="mt-1.5 text-[12px] text-destructive">
            {copy.name} keys start with <span className="font-mono">{chosen.prefix}</span>.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!isValidKeyFormat(trimmed)}
          className="auth-btn auth-btn-primary auth-focus mt-3"
        >
          {intent ? "Save and continue" : "Save key"}
        </button>
      </form>

      {saved ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-[hsl(var(--auth-line))] bg-white/[0.02] px-3 py-2.5 text-[12.5px]">
          <Check className="size-[15px] shrink-0 text-success" aria-hidden />
          <span className="min-w-0 flex-1 text-muted-foreground">
            Saved {savedProvider?.label ?? ""}
            <span className="ml-1 font-mono text-foreground/80">{maskKey(saved)}</span>
          </span>
          <button
            onClick={clear}
            className="auth-focus inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-destructive"
          >
            <Trash2 className="size-3.5" /> Remove
          </button>
        </div>
      ) : null}

      {/* Detail, one click away. Checkable without being a wall. */}
      <details className="group mt-5 border-t border-[hsl(var(--auth-line))] pt-4">
        <summary
          className={cn(
            "auth-focus flex cursor-pointer list-none items-center gap-1.5 rounded",
            "text-[12.5px] text-muted-foreground transition-colors hover:text-foreground",
            "[&::-webkit-details-marker]:hidden",
          )}
        >
          <ChevronRight
            className="size-3.5 transition-transform duration-150 group-open:rotate-90"
            aria-hidden
          />
          What happens to your key
        </summary>
        <ul className="mt-3 space-y-2 pl-5 text-[12px] leading-relaxed text-muted-foreground/80">
          <li>Stored in this browser only. It is never written to our database.</li>
          <li>Sent with each request, used once, and never logged — including inside errors.</li>
          <li>
            Only ever used for requests from
            {accountEmail ? (
              <span className="text-foreground/85"> {accountEmail}</span>
            ) : (
              " your own account"
            )}
            .
          </li>
          <li>Sent only to {savedProvider?.label ?? "the provider it belongs to"} — never to any other service.</li>
          <li>Remove it here, or revoke it with your provider, at any time.</li>
        </ul>
      </details>

      {/* Naming the account is the anti-phishing cue copy alone can't give. */}
      {accountEmail ? (
        <p className="mt-5 truncate text-[12px] text-muted-foreground/60">
          Signed in as <span className="text-muted-foreground">{accountEmail}</span>
        </p>
      ) : null}
    </div>
  );
}
