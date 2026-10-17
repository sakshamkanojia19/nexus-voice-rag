/**
 * Which browser storage a conversation index belongs to.
 *
 * This exists because the original rule was wrong in a way that is invisible
 * until two people share a computer. Conversations were keyed by a *browser*
 * id — `nexus_convos_<session>` — that never changed when the account did. So:
 *
 *   - signing out left the previous user's chats on screen, and
 *   - signing in as somebody else **adopted** them, because the key still
 *     matched.
 *
 * Ownership now comes from the account, mirroring how the server scopes the
 * same data (`Principal.owner_key` in `backend/auth.py`). Signing out switches
 * to the anonymous bucket, which is empty, so the app comes back fresh; signing
 * back in returns you to your own.
 */

const PREFIX = "nexus_convos_";

/** The bucket for a caller with no account. Deliberately shared and boring —
 *  nothing sensitive should ever accumulate here, because the whole app is
 *  gated behind sign-in on any deployment that requires auth. */
export const ANON_OWNER = "anon";

/**
 * Namespaced so a Supabase uuid can never collide with the anonymous bucket,
 * matching the server's `kind:subject` convention.
 */
export function ownerKeyFor(userId: string | null | undefined): string {
  return userId ? `user:${userId}` : ANON_OWNER;
}

export function conversationsStorageKey(ownerKey: string): string {
  return PREFIX + ownerKey;
}

/** Every conversation bucket currently in this browser. */
export function conversationKeys(storage: Pick<Storage, "length" | "key">): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIX)) out.push(k);
  }
  return out;
}

/**
 * Buckets written under the old browser-scoped rule, which belong to nobody in
 * particular and may hold a previous user's chats.
 *
 * Recognised by *not* being one of the namespaced buckets: the new scheme only
 * ever produces `user:<uuid>` or `anon`, so anything else is a legacy
 * `nexus_convos_s_<random>` and is safe — and correct — to drop.
 */
export function legacyConversationKeys(storage: Pick<Storage, "length" | "key">): string[] {
  return conversationKeys(storage).filter((k) => {
    const owner = k.slice(PREFIX.length);
    return owner !== ANON_OWNER && !owner.startsWith("user:");
  });
}

/** Remove pre-scoping conversation data. Returns how many buckets were dropped. */
export function purgeLegacyConversations(storage: Storage): number {
  const keys = legacyConversationKeys(storage);
  for (const k of keys) {
    try {
      storage.removeItem(k);
    } catch {/* storage disabled — nothing we can do, and nothing breaks */}
  }
  return keys.length;
}

// ── Cross-device sync ────────────────────────────────────────────────────────
/**
 * Reconciling two devices' views of the same history.
 *
 * The server is not simply authoritative. A conversation can be newer here
 * (you just spoke) or newer there (you spoke on your phone), and local storage
 * still has to work with no network at all. So local storage stays the thing
 * the UI reads — instant, offline — and this decides, per conversation, which
 * side is ahead.
 *
 * The rule is last-write-wins on `updatedAt`. That is not conflict resolution
 * in the CRDT sense and does not pretend to be: if the same conversation is
 * genuinely edited on two devices at once, one side's turn is lost. For a chat
 * log that is nearly always the right trade — the alternative is merge UI
 * nobody wants for a transcript that is append-only in practice.
 *
 * The server list carries no message bodies (see `list_meta` — sending every
 * message to render a sidebar would be megabytes), so a conversation that is
 * newer remotely comes back as a stub flagged `needsFetch`, and its body is
 * pulled when it is opened.
 */
export interface RemoteConversationMeta {
  id: string;
  title: string;
  /** ISO-8601, as Postgres returns it. */
  updated_at: string;
}

/** The shape this module needs; `useChat`'s StoredConversation satisfies it. */
export interface SyncableConversation {
  id: string;
  title: string;
  updatedAt: number;
  needsFetch?: boolean;
}

export interface MergeResult<T> {
  merged: T[];
  /** Ids that are absent or older on the server and should be pushed up. */
  toPush: string[];
}

/** Parse a Postgres timestamptz, treating anything unparseable as "very old"
 *  so a malformed row can never win against real local work. */
function remoteTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function mergeConversations<T extends SyncableConversation>(
  local: T[],
  remote: RemoteConversationMeta[],
  /** Builds a body-less placeholder for a conversation only the server has. */
  makeStub: (meta: RemoteConversationMeta, updatedAt: number) => T,
): MergeResult<T> {
  const byId = new Map<string, T>();
  for (const conversation of local) byId.set(conversation.id, conversation);

  const toPush: string[] = [];
  const seenRemote = new Set<string>();

  for (const meta of remote) {
    seenRemote.add(meta.id);
    const updatedAt = remoteTime(meta.updated_at);
    const mine = byId.get(meta.id);

    if (!mine) {
      // Only the server has it — another device. Take the stub.
      byId.set(meta.id, makeStub(meta, updatedAt));
      continue;
    }
    if (updatedAt > mine.updatedAt) {
      // Their copy is ahead: keep ours on screen until the body arrives, but
      // mark it so opening the conversation pulls the newer messages.
      byId.set(meta.id, { ...mine, title: meta.title, updatedAt, needsFetch: true });
    } else if (mine.updatedAt > updatedAt) {
      toPush.push(meta.id); // we are ahead
    }
  }

  // Never synced at all — first run, or written while offline.
  for (const conversation of local) {
    if (!seenRemote.has(conversation.id)) toPush.push(conversation.id);
  }

  const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return { merged, toPush };
}
