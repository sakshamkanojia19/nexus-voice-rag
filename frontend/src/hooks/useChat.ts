import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessError,
  deleteConversation as deleteConversationRemote,
  fetchConversation,
  listConversations,
  putConversation,
  streamChat,
  type ChatMessage,
  type SearchMode,
  type Source,
} from "@/lib/api";
import { ANON_OWNER, conversationsStorageKey, mergeConversations } from "@/lib/chatStorage";
import { config, debugLog } from "@/lib/config";

/** Appended to an assistant turn the user cut off. The backend's system prompt
 *  explains it to the model (context_builder.py, "WHEN YOU WERE INTERRUPTED"). */
export const INTERRUPTED_MARKER = "[the user interrupted me here]";

export interface ToolActivity {
  name: string;
  query: string;
  /** When the step was announced — drives the per-step duration in the UI. */
  startedAt?: number;
}

export interface ChatTurn extends ChatMessage {
  id: string;
  timestamp: number;
  status?: "streaming" | "complete" | "error";
  fromVoice?: boolean;
  tools?: ToolActivity[];
  sources?: Source[];
  interrupted?: boolean;
  /** Which composer mode produced the turn — the activity block words itself
   *  differently for a one-shot web lookup vs. multi-step deep research. */
  mode?: SearchMode;
  /** Wall-clock bounds of the turn, for the "took 4.2s" summary. */
  startedAt?: number;
  endedAt?: number;
  /** The model that wrote this reply, as the server reported it. Absent on
   *  canned answers (no model ran) and on turns saved before it was tracked. */
  model?: string;
  provider?: string;
}

export interface SendOptions {
  fromVoice?: boolean;
  docIds?: string[] | null;
  botName?: string;
  replyLanguage?: string;
  mode?: SearchMode;
  thinking?: boolean;
  model?: string | null;
}

/** Lightweight metadata for the Recents list in the sidebar. */
export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatTurn[];
  /**
   * The server has a newer copy than the one cached here — either written on
   * another device, or known only from the metadata list, which carries no
   * message bodies. The body is pulled when the conversation is opened rather
   * than eagerly, so the sidebar costs one small request instead of every
   * message of every conversation.
   */
  needsFetch?: boolean;
}

export interface UseChatReturn {
  messages: ChatTurn[];
  isStreaming: boolean;
  send: (text: string, opts?: SendOptions) => Promise<void>;
  abort: () => void;
  /** Cut the last assistant turn down to what the user actually heard. */
  truncateLastAssistant: (heard: string) => void;
  clear: () => void;
  // ── Conversation history ──
  conversations: ConversationMeta[];
  activeId: string | null;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
}

function newId(): string {
  return "m_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ── Persistence: many conversations, scoped to the ACCOUNT ───────────────────
// Not to the browser. Keying these by a browser id meant signing out left the
// previous user's chats on screen and signing in as somebody else adopted them.
// See lib/chatStorage.ts.
const MAX_CONVOS = 40; // keep the most recent N conversations
const MAX_TURNS = 80; // cap turns stored per conversation
/** How long a settled conversation waits before being pushed up, so a rename or
 *  a quick exchange coalesces into one write instead of several. */
const PUSH_DEBOUNCE_MS = 1200;
/** Cap on catch-up writes per sync, so a first run against a long local history
 *  doesn't fire one request per conversation all at once. */
const MAX_PUSH_PER_SYNC = 10;

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  return t.length > 48 ? t.slice(0, 48).trimEnd() + "…" : t;
}

function normalize(t: ChatTurn): ChatTurn {
  return { ...t, status: "complete" };
}

function loadConvos(ownerKey: string): StoredConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(conversationsStorageKey(ownerKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredConversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
      .map((c) => ({
        ...c,
        messages: c.messages
          .filter((t) => (t.role === "user" || t.role === "assistant") && t.content.trim())
          .map(normalize),
      }))
      .filter((c) => c.messages.length > 0);
  } catch {
    return [];
  }
}

function persistConvos(ownerKey: string, list: StoredConversation[]): void {
  if (typeof window === "undefined") return;
  try {
    const slim = list.slice(0, MAX_CONVOS).map((c) => ({
      ...c,
      messages: c.messages.filter((t) => t.status !== "streaming" && t.content.trim()).slice(-MAX_TURNS),
    }));
    localStorage.setItem(conversationsStorageKey(ownerKey), JSON.stringify(slim));
  } catch {/* quota / serialization — non-fatal */}
}

export function useChat(
  options: {
    onAssistantFinal?: (text: string, fromVoice: boolean) => void;
    onAssistantDelta?: (fullText: string, fromVoice: boolean) => void;
    /**
     * The agent announced a tool call — fired BEFORE the tool runs, i.e. at the
     * start of the slowest stretch of the turn. Voice chat uses this to speak a
     * brief acknowledgment so a multi-second web search doesn't play as silence.
     */
    onToolActivity?: (name: string, query: string, fromVoice: boolean) => void;
    /** The server refused for a reason the user can act on (sign in / add a key). */
    onAccessError?: (error: AccessError) => void;
    /**
     * Whose conversations these are — `user:<uuid>` or `anon`. Changing it
     * swaps buckets and wipes the view, which is what makes sign-out come back
     * to a clean app instead of the last person's transcript.
     */
    ownerKey?: string;
  } = {},
): UseChatReturn {
  const ownerKey = options.ownerKey ?? ANON_OWNER;
  // Owner and list are ONE state value on purpose. Held separately, the commit
  // where `ownerKey` changes but the list hasn't reloaded yet would let the
  // persist effect write the outgoing user's conversations into the incoming
  // user's bucket — the precise leak this whole change exists to close.
  const [store, setStore] = useState<{ owner: string; list: StoredConversation[] }>(() => ({
    owner: ownerKey,
    list: loadConvos(ownerKey),
  }));
  const conversations = store.list;
  const setConversations = useCallback(
    (next: StoredConversation[] | ((list: StoredConversation[]) => StoredConversation[])) => {
      setStore((s) => ({
        ...s,
        list: typeof next === "function" ? next(s.list) : next,
      }));
    },
    [],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const activeAssistantIdRef = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const onFinalRef = useRef(options.onAssistantFinal);
  onFinalRef.current = options.onAssistantFinal;
  const onDeltaRef = useRef(options.onAssistantDelta);
  onDeltaRef.current = options.onAssistantDelta;
  const onToolActivityRef = useRef(options.onToolActivity);
  onToolActivityRef.current = options.onToolActivity;
  const onAccessErrorRef = useRef(options.onAccessError);
  onAccessErrorRef.current = options.onAccessError;

  // Identity changed: drop everything on screen and load that account's own
  // history. This is what makes signing out return to a clean app rather than
  // the previous person's transcript.
  useEffect(() => {
    if (store.owner === ownerKey) return;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setIsStreaming(false);
    activeAssistantIdRef.current = null;
    activeIdRef.current = null;
    setActiveId(null);
    setMessages([]);
    setStore({ owner: ownerKey, list: loadConvos(ownerKey) });
  }, [ownerKey, store.owner]);

  // Persist into the bucket the loaded list actually belongs to. The guard is
  // on `store.owner`, not `ownerKey`, so during the commit where the two differ
  // nothing is written at all.
  useEffect(() => {
    if (store.owner !== ownerKey) return;
    persistConvos(store.owner, store.list);
  }, [store, ownerKey]);

  // ── Sync: pull ─────────────────────────────────────────────────────────────
  // On load, and whenever the account changes, reconcile with the server. Local
  // storage has already rendered by now, so this fills in conversations from
  // other devices rather than gating first paint on a network round trip.
  useEffect(() => {
    if (ownerKey === ANON_OWNER) return; // nothing to sync without an account
    let cancelled = false;

    void listConversations()
      .then(({ conversations: remote, synced }) => {
        if (cancelled || !synced) return;
        const { merged, toPush } = mergeConversations<StoredConversation>(
          conversationsRef.current,
          remote,
          (meta, updatedAt) => ({
            id: meta.id,
            title: meta.title || "New chat",
            createdAt: updatedAt,
            updatedAt,
            messages: [],
            needsFetch: true,
          }),
        );
        // Guard against the account changing while the request was in flight —
        // writing here would drop one user's list into another's bucket.
        setStore((s) => (s.owner === ownerKey ? { ...s, list: merged.slice(0, MAX_CONVOS) } : s));

        // Anything the server is missing or behind on. Bounded so a first sync
        // from a heavy local history doesn't fire a hundred requests at once.
        for (const id of toPush.slice(0, MAX_PUSH_PER_SYNC)) {
          const conv = merged.find((c) => c.id === id);
          if (!conv || conv.messages.length === 0) continue;
          void putConversation(id, conv.title, conv.messages).catch((e) =>
            debugLog("conversation push failed", e),
          );
        }
      })
      .catch((e) => debugLog("conversation sync unavailable", e));

    return () => { cancelled = true; };
  }, [ownerKey]);

  // Mirror the active working messages into the stored conversation once the
  // turn settles (we never write mid-stream to keep streaming snappy).
  useEffect(() => {
    if (isStreaming) return;
    const cid = activeIdRef.current;
    if (!cid || messages.length === 0) return;
    const cleanMsgs = messages.filter((t) => t.content.trim());
    if (cleanMsgs.length === 0) return;
    setConversations((list) => {
      const idx = list.findIndex((c) => c.id === cid);
      if (idx === -1) {
        const conv: StoredConversation = {
          id: cid,
          title: titleFrom(messages.find((m) => m.role === "user")?.content ?? "New chat"),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: cleanMsgs,
        };
        return [conv, ...list].slice(0, MAX_CONVOS);
      }
      const next = list.slice();
      next[idx] = { ...next[idx], messages: cleanMsgs, updatedAt: Date.now() };
      return next;
    });
  }, [messages, isStreaming]);

  // ── Sync: push ─────────────────────────────────────────────────────────────
  // Mirror the settled conversation up. Keyed on the same "turn finished"
  // condition as the local write, never mid-stream: pushing every delta would
  // be a request per token for a row that is rewritten whole each time.
  useEffect(() => {
    if (isStreaming || ownerKey === ANON_OWNER) return;
    const cid = activeIdRef.current;
    if (!cid) return;
    const conv = conversationsRef.current.find((c) => c.id === cid);
    if (!conv || conv.messages.length === 0) return;

    // Debounced so a rename or a rapid exchange coalesces into one write.
    const t = window.setTimeout(() => {
      void putConversation(cid, conv.title, conv.messages).catch((e) =>
        debugLog("conversation push failed", e),
      );
    }, PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [store, isStreaming, ownerKey]);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      streamingRef.current = false;
      const assistantId = activeAssistantIdRef.current;
      activeAssistantIdRef.current = null;
      if (assistantId) {
        setMessages((turns) =>
          turns.flatMap((turn) => {
            if (turn.id !== assistantId) return [turn];
            return turn.content.trim()
              ? [{ ...turn, status: "complete" as const, interrupted: true }]
              : [];
          }),
        );
      }
      setIsStreaming(false);
    }
  }, []);

  /**
   * After a genuine barge-in, replace the last assistant turn with only the
   * portion that reached the speaker. Without this the model's history claims it
   * said sentences the user never heard, and it answers follow-ups accordingly.
   * An empty `heard` means nothing was audible, so the turn is dropped entirely.
   */
  const truncateLastAssistant = useCallback((heard: string) => {
    const spoken = heard.trim();
    setMessages((turns) => {
      let idx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i]?.role === "assistant") { idx = i; break; }
      }
      if (idx === -1) return turns;
      const turn = turns[idx];
      if (!turn) return turns;
      // Never grow the turn — spoken text is the cleaned-for-speech form, which
      // can differ from the rendered markdown.
      if (spoken.length >= turn.content.trim().length) return turns;
      if (!spoken) return turns.filter((_, i) => i !== idx);
      const next = [...turns];
      next[idx] = { ...turn, content: spoken, status: "complete" as const, interrupted: true };
      return next;
    });
  }, []);

  const newConversation = useCallback(() => {
    abort();
    activeIdRef.current = null;
    setActiveId(null);
    setMessages([]);
  }, [abort]);

  const selectConversation = useCallback((id: string) => {
    abort();
    const conv = conversationsRef.current.find((c) => c.id === id);
    activeIdRef.current = id;
    setActiveId(id);
    // Render whatever is cached immediately — an empty pane while a fetch runs
    // is the thing that makes sync feel slower than no sync at all.
    setMessages(conv ? conv.messages.map(normalize) : []);

    // Written on another device, or newer there: pull the body.
    if (!conv || conv.needsFetch) {
      void fetchConversation(id)
        .then((remote) => {
          if (!remote || activeIdRef.current !== id) return;
          const msgs = (remote.messages as ChatTurn[]).filter(
            (t) => t && (t.role === "user" || t.role === "assistant") && t.content?.trim(),
          ).map(normalize);
          setMessages(msgs);
          setConversations((list) =>
            list.map((c) =>
              c.id === id
                ? { ...c, title: remote.title || c.title, messages: msgs, needsFetch: false }
                : c,
            ),
          );
        })
        .catch((e) => debugLog("conversation fetch failed", e));
    }
  }, [abort, setConversations]);

  const renameConversation = useCallback((id: string, title: string) => {
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) return;
    setConversations((list) => list.map((c) => (c.id === id ? { ...c, title: clean } : c)));
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((list) => list.filter((c) => c.id !== id));
    // Locally first, server after: a delete that only half-applied should leave
    // the conversation gone from the device the user is looking at. A failure
    // here means it reappears on the next pull, which is recoverable — the
    // opposite order would leave it deleted everywhere but still on screen.
    void deleteConversationRemote(id).catch((e) => debugLog("remote delete failed", e));
    if (activeIdRef.current === id) {
      abort();
      activeIdRef.current = null;
      setActiveId(null);
      setMessages([]);
    }
  }, [abort, setConversations]);

  const send = useCallback(async (text: string, opts: SendOptions = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (streamingRef.current) {
      debugLog("chat send ignored: a reply is already streaming");
      return;
    }
    const fromVoice = !!opts.fromVoice;

    // Start a fresh conversation lazily on the first message.
    if (!activeIdRef.current) {
      const cid = newId();
      activeIdRef.current = cid;
      setActiveId(cid);
      setConversations((list) =>
        [{ id: cid, title: titleFrom(trimmed), createdAt: Date.now(), updatedAt: Date.now(), messages: [] }, ...list].slice(
          0,
          MAX_CONVOS,
        ),
      );
    }

    const userTurn: ChatTurn = {
      id: newId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
      status: "complete",
      fromVoice,
    };
    const assistantId = newId();
    const assistantTurn: ChatTurn = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      status: "streaming",
      tools: [],
      mode: opts.mode ?? "web",
      startedAt: Date.now(),
    };
    activeAssistantIdRef.current = assistantId;

    setMessages((m) => [...m, userTurn, assistantTurn]);

    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;
    setIsStreaming(true);

    const history: ChatMessage[] = [];
    setMessages((current) => {
      // Snapshot history at this moment for the request (excluding the just-added pair).
      for (const t of current.slice(-20, -2)) {
        if (t.role !== "user" && t.role !== "assistant") continue;
        // An interrupted reply stays in, as only what the user actually heard
        // (truncateLastAssistant trimmed it) plus a marker saying where it was
        // cut. Dropping it left the model looking at two questions in a row
        // with no answer between them, so it tried to answer both instead of
        // following the user's change of subject.
        const content =
          t.role === "assistant" && t.interrupted
            ? `${t.content.trim()} ${INTERRUPTED_MARKER}`
            : t.content;
        history.push({ role: t.role, content });
      }
      return current;
    });

    let acc = "";
    let finalSources: Source[] | undefined;
    // Turn latency breakdown — the network+model half of the budget. The voice
    // half (speech-end → here) is logged by useVoice.
    const sentAt = Date.now();
    let firstDeltaLogged = false;
    try {
      for await (const ev of streamChat(
        {
          message: trimmed,
          conversation_history: history,
          stream: true,
          bot_name: opts.botName ?? config.botName,
          from_voice: fromVoice,
          doc_ids: opts.docIds ?? null,
          reply_language: opts.replyLanguage ?? null,
          mode: opts.mode ?? "web",
          thinking: opts.thinking ?? false,
          model: opts.model ?? null,
        },
        controller.signal,
      )) {
        if (ev.type === "delta") {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            debugLog(`chat: time-to-first-token ${Date.now() - sentAt}ms`);
          }
          acc += ev.text;
          setMessages((m) => m.map((t) => (t.id === assistantId ? { ...t, content: acc } : t)));
          onDeltaRef.current?.(acc, fromVoice);
        } else if (ev.type === "tool") {
          onToolActivityRef.current?.(ev.name, ev.query, fromVoice);
          setMessages((m) =>
            m.map((t) =>
              t.id === assistantId
                ? { ...t, tools: [...(t.tools ?? []), { name: ev.name, query: ev.query, startedAt: Date.now() }] }
                : t,
            ),
          );
        } else if (ev.type === "meta") {
          setMessages((m) =>
            m.map((t) => (t.id === assistantId ? { ...t, model: ev.model, provider: ev.provider } : t)),
          );
        } else if (ev.type === "sources") {
          finalSources = ev.items;
          setMessages((m) => m.map((t) => (t.id === assistantId ? { ...t, sources: ev.items } : t)));
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
      if (!acc.trim()) throw new Error("The model returned an empty response.");
      setMessages((m) =>
        m.map((t) =>
          t.id === assistantId
            ? { ...t, status: "complete", sources: finalSources ?? t.sources, endedAt: Date.now() }
            : t,
        ),
      );
      onFinalRef.current?.(acc, fromVoice);
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      if (aborted) {
        setMessages((turns) =>
          turns.flatMap((turn) => {
            if (turn.id !== assistantId) return [turn];
            return turn.content.trim()
              ? [{ ...turn, status: "complete" as const, interrupted: true }]
              : [];
          }),
        );
      } else {
        debugLog("chat error", e);
        // Sign-in and API-key refusals are things the user can fix, so they are
        // handed up for the app to prompt on rather than left as dead text in
        // the transcript.
        if (e instanceof AccessError) onAccessErrorRef.current?.(e);
        const msg = (e as Error).message || "Couldn't reach the server.";
        setMessages((m) =>
          m.map((t) => (t.id === assistantId ? { ...t, content: msg, status: "error" } : t)),
        );
      }
    } finally {
      // An interrupted request may settle after the replacement turn starts.
      // Never let the old finally block clear the new turn's controller/state.
      if (abortRef.current === controller) {
        streamingRef.current = false;
        activeAssistantIdRef.current = null;
        setIsStreaming(false);
        abortRef.current = null;
      }
    }
  }, []);

  const conversationsMeta = useMemo<ConversationMeta[]>(
    () =>
      conversations
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    [conversations],
  );

  return {
    messages,
    isStreaming,
    send,
    abort,
    truncateLastAssistant,
    clear: newConversation,
    conversations: conversationsMeta,
    activeId,
    newConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
  };
}
