import { config } from "./config";
import { loadApiKey } from "./apiKey";

/**
 * The access token for the signed-in user, if any. Set by the auth layer rather
 * than imported from it, so this module stays dependency-free and usable before
 * Supabase is configured.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Header the server reads a caller-supplied key from — any provider's; the
 *  server tells them apart by prefix. */
const USER_KEY_HEADER = "X-Provider-Key";

/**
 * Fetch options carrying identity. `credentials: "include"` is what lets the
 * server-issued anonymous cookie travel cross-origin (the frontend is on :5173,
 * the API on :8001) — without it every request would look like a brand-new
 * visitor and documents would vanish between calls.
 *
 * The BYOK key rides here too, read fresh on every call rather than captured
 * once: the user can add, change or clear it mid-session and the very next
 * request must reflect that.
 */
function authInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const userKey = loadApiKey();
  if (userKey) headers.set(USER_KEY_HEADER, userKey);
  return { ...init, headers, credentials: "include" };
}

/** Raised when the server refuses the request for an access reason the UI can
 *  act on, rather than a generic failure it can only report. */
export class AccessError extends Error {
  constructor(
    /** `signin` — sign in required. `apikey` — the caller must supply a key. */
    readonly reason: "signin" | "apikey",
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

/** Map the two access statuses onto something the UI can branch on. */
export function accessErrorFor(status: number, detail: string): AccessError | null {
  if (status === 401) return new AccessError("signin", detail || "Sign in to continue.");
  if (status === 402) return new AccessError("apikey", detail || "An API key is required.");
  return null;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Source {
  n: number;
  type: "document" | "web";
  label: string;
  url?: string | null;
  snippet?: string;
  doc_name?: string | null;
  page?: number | null;
}

/** A single document the user has uploaded. */
export interface DocumentMeta {
  doc_id: string;
  name: string;
  size: number;
  status: "processing" | "ready" | "error";
  error?: string | null;
  n_chunks: number;
  pages: number[];
}

/** Typed events streamed back from /chat (NDJSON, one JSON object per line). */
export type ChatEvent =
  /** First event of a model-generated reply: which model is answering. */
  | { type: "meta"; model: string; provider: string }
  | { type: "tool"; name: string; query: string }
  | { type: "delta"; text: string }
  | { type: "sources"; items: Source[] }
  | { type: "done" }
  | { type: "error"; message: string };

/** Which composer chip the turn was sent from. */
export type SearchMode = "instant" | "web" | "deep";

export interface ChatRequest {
  message: string;
  conversation_history: ChatMessage[];
  stream: boolean;
  bot_name?: string;
  from_voice?: boolean;
  doc_ids?: string[] | null;
  reply_language?: string | null;
  mode?: SearchMode;
  thinking?: boolean;
  /** Ignored by the server unless it's in the configured allowlist. */
  model?: string | null;
}

function parseChatEvent(line: string): ChatEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const value = parsed as Record<string, unknown>;
  if (typeof value.type === "string") return value as unknown as ChatEvent;

  // Older/degraded backend paths can return { error: "..." } as ordinary
  // JSON. Convert it into the streaming contract instead of silently dropping
  // it and leaving an empty assistant turn in the UI.
  if (typeof value.error === "string") {
    return { type: "error", message: value.error };
  }
  if (typeof value.detail === "string") {
    return { type: "error", message: value.detail };
  }
  return null;
}

/** Stream the agentic chat reply as typed NDJSON events. */
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent, void, void> {
  const res = await fetch(
    `${config.apiUrl}/chat`,
    authInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    }),
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    // FastAPI wraps HTTPException detail in {"detail": "..."}; fall back to the
    // raw body for anything that isn't ours.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: string };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch { /* not JSON — use the raw text */ }
    const access = accessErrorFor(res.status, detail);
    if (access) throw access;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawEvent = false;

  const drain = function* (flush: boolean): Generator<ChatEvent> {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const event = parseChatEvent(line);
        if (event) {
          sawEvent = true;
          yield event;
        }
      }
    }
    if (flush && buffer.trim()) {
      const event = parseChatEvent(buffer.trim());
      if (event) {
        sawEvent = true;
        yield event;
      }
      buffer = "";
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    yield* drain(false);
  }
  yield* drain(true);
  if (!sawEvent) throw new Error("The server returned an empty chat response.");
}

/** Upload one or more documents for ingestion (parse → chunk → embed).
 *  Ownership comes from the auth cookie/token, never from a field we send. */
export async function uploadDocuments(files: File[]): Promise<DocumentMeta[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(`${config.apiUrl}/upload`, authInit({ method: "POST", body: form }));
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    // Ingesting embeds every chunk, so upload spends a key and can answer 401 /
    // 402 exactly like /chat does. Both need to land as an AccessError or the
    // UI reports "add your key" as an unexplained red string instead of the
    // prompt that fixes it.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch { /* not JSON — use the raw text */ }
    const access = accessErrorFor(res.status, detail);
    if (access) throw access;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { documents: DocumentMeta[] };
  return data.documents ?? [];
}

export async function listDocuments(): Promise<DocumentMeta[]> {
  const res = await fetch(`${config.apiUrl}/documents`, authInit());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { documents: DocumentMeta[] };
  return data.documents ?? [];
}

export async function deleteDocument(docId: string): Promise<boolean> {
  const res = await fetch(
    `${config.apiUrl}/documents/${encodeURIComponent(docId)}`,
    authInit({ method: "DELETE" }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { deleted: boolean };
  return data.deleted;
}

/** Transcribe a recorded audio blob via the backend (Whisper). */
export async function transcribe(
  blob: Blob,
  prompt = "",
  language = "",
): Promise<string> {
  const form = new FormData();
  const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
  form.append("file", blob, `voice.${ext}`);
  if (prompt) form.append("prompt", prompt);
  if (language) form.append("language", language);
  const res = await fetch(
    `${config.apiUrl}/transcribe`,
    authInit({ method: "POST", body: form }),
  );
  if (!res.ok) throw new Error(`transcribe failed: HTTP ${res.status}`);
  const data = (await res.json()) as { text?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return (data.text ?? "").trim();
}

/** Query autocomplete. Relayed by our backend because the upstream suggestion
 *  endpoints send no CORS headers and can't be called from the browser. */
export async function fetchSuggestions(
  q: string,
  lang: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const params = new URLSearchParams({ q });
  if (lang) params.set("lang", lang);
  const res = await fetch(`${config.apiUrl}/suggest?${params}`, authInit({ signal }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { suggestions?: string[] };
  return data.suggestions ?? [];
}

/** The picker's options, served by the backend so its allowlist is the single
 *  source of truth. Falls back to an empty list, which hides the picker. */
export async function listModels(): Promise<{ models: string[]; default: string; provider?: string }> {
  const res = await fetch(`${config.apiUrl}/models`, authInit());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { models: string[]; default: string; provider?: string };
}

/** What this deployment expects of the caller. Lets the UI prompt for a key or
 *  a sign-in up front, instead of discovering the requirement via a failure. */
export interface ServerCapabilities {
  status: string;
  provider: string;
  auth?: { supabase_configured: boolean; authenticated: boolean; required: boolean };
  byok?: {
    accepted: boolean;
    required: boolean;
    /** A caller-supplied key is only honoured from a signed-in account, so the
     *  client must collect the account before it asks for the key. */
    requires_auth: boolean;
    server_key_available: boolean;
  };
  stt_backend?: string;
  /** Which local transcriber is actually resident. `loaded` is null until the
   *  weights are in memory, and `downgraded` means the machine could not hold
   *  the configured tier and fell back to a less accurate one — worth surfacing,
   *  because it silently caps how well anything spoken can be understood. */
  stt_local?: {
    configured: string;
    loaded: string | null;
    device: string;
    compute: string;
    downgraded: boolean;
  };
}

export async function healthCheck(): Promise<ServerCapabilities> {
  const res = await fetch(`${config.apiUrl}/health`, authInit());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ServerCapabilities;
}

// ── Conversation history (cross-device sync) ─────────────────────────────────
// None of these take an owner: the server scopes every row by the verified
// principal, so a conversation id from another account simply matches nothing.
//
// Every call is best-effort. Sync is an enhancement over the local cache, so a
// failure here must leave the app working rather than surface an error — the
// callers log and carry on.

export interface RemoteConversationMeta {
  id: string;
  title: string;
  updated_at: string;
}

export interface RemoteConversation extends RemoteConversationMeta {
  messages: unknown[];
}

/** Conversation headers only — no message bodies. */
export async function listConversations(): Promise<{
  conversations: RemoteConversationMeta[];
  synced: boolean;
}> {
  const res = await fetch(`${config.apiUrl}/conversations`, authInit());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { conversations: RemoteConversationMeta[]; synced: boolean };
}

export async function fetchConversation(id: string): Promise<RemoteConversation | null> {
  const res = await fetch(
    `${config.apiUrl}/conversations/${encodeURIComponent(id)}`,
    authInit(),
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RemoteConversation;
}

export async function putConversation(
  id: string,
  title: string,
  messages: unknown[],
): Promise<boolean> {
  const res = await fetch(
    `${config.apiUrl}/conversations/${encodeURIComponent(id)}`,
    authInit({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, messages }),
    }),
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { saved?: boolean };
  return data.saved === true;
}

export async function deleteConversation(id: string): Promise<boolean> {
  const res = await fetch(
    `${config.apiUrl}/conversations/${encodeURIComponent(id)}`,
    authInit({ method: "DELETE" }),
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { deleted?: boolean };
  return data.deleted === true;
}
