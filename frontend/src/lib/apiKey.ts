/**
 * The user's own API key (BYOK) — OpenAI, xAI (Grok) or Groq.
 *
 * The key lives in this browser and nowhere else. It is attached to each API
 * request as a header, used by the server for that request, and never written
 * to a database or a log there — see `backend/credentials.py` for the matching
 * guarantees on the other side. Which provider it is spent on is read from its
 * prefix, on both sides, so there is no separate setting that could disagree.
 *
 * Stored in `localStorage`, which is a deliberate trade rather than an
 * oversight. The alternatives are worse for this shape of app:
 *
 *   - `sessionStorage` would force re-entry on every tab and reload, which in
 *     practice pushes people to paste the key into a note file instead.
 *   - a cookie would be sent automatically on every request to the origin,
 *     including ones this code never made, and would still be readable by
 *     anything able to run script on the page.
 *
 * `localStorage` is readable by script on this origin, so the real defence is
 * that nothing untrusted runs here: no third-party embeds, no `eval` of remote
 * text, and a strict origin. The key is scoped to one vendor and is revocable
 * by the user at any time, which is the property that makes this acceptable.
 */

/** Named for the days when only OpenAI keys existed. Kept, so a key saved
 *  before other providers were added is still found. */
const STORAGE_KEY = "nexus_openai_key";

export type ProviderId = "openai" | "xai" | "groq";

export interface KeyProvider {
  id: ProviderId;
  label: string;
  prefix: string;
  /** Mirrors the server's check so a typo is caught here rather than after a
   *  round trip. */
  pattern: RegExp;
  keysUrl: string;
  /** Can embed documents. Without it, uploads are refused server-side. */
  documents: boolean;
}

export const KEY_PROVIDERS: readonly KeyProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    prefix: "sk-",
    pattern: /^sk-[A-Za-z0-9_-]{16,250}$/,
    keysUrl: "https://platform.openai.com/api-keys",
    documents: true,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    prefix: "xai-",
    pattern: /^xai-[A-Za-z0-9_-]{16,250}$/,
    keysUrl: "https://console.x.ai",
    documents: false,
  },
  {
    id: "groq",
    label: "Groq",
    prefix: "gsk_",
    pattern: /^gsk_[A-Za-z0-9]{16,250}$/,
    keysUrl: "https://console.groq.com/keys",
    documents: false,
  },
];

/** The provider a well-formed key belongs to, or null for anything else. */
export function detectProvider(key: string | null | undefined): KeyProvider | null {
  const k = (key ?? "").trim();
  return KEY_PROVIDERS.find((p) => p.pattern.test(k)) ?? null;
}

export function isValidKeyFormat(key: string): boolean {
  return detectProvider(key) !== null;
}

/** Safe to render: enough to recognise which key this is, never enough to use. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 11) {
    const prefix = KEY_PROVIDERS.find((p) => k.startsWith(p.prefix))?.prefix ?? "sk-";
    return `${prefix}…`;
  }
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export function loadApiKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // A stored value that no longer parses is treated as absent rather than
    // sent: a malformed key produces a 400 on every single request otherwise.
    return stored && isValidKeyFormat(stored) ? stored : null;
  } catch {
    return null; // storage disabled (private mode, blocked cookies)
  }
}

export function saveApiKey(key: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (key && isValidKeyFormat(key)) localStorage.setItem(STORAGE_KEY, key.trim());
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled — the key still works for this page's lifetime */
  }
}
