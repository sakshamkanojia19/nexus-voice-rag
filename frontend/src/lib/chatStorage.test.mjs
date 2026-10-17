// Exercises the real src/lib/chatStorage.ts: which browser bucket a
// conversation index belongs to.
//
// This is a regression suite before it is anything else. The original rule
// keyed conversations by a *browser* id that never changed when the account
// did, so signing out left the previous user's chats on screen and signing in
// as somebody else silently adopted them. Every check below is one half of
// that bug.
import {
  ANON_OWNER,
  conversationKeys,
  conversationsStorageKey,
  legacyConversationKeys,
  mergeConversations,
  ownerKeyFor,
  purgeLegacyConversations,
} from "./chatStorage.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

/** Minimal localStorage stand-in — index order matters for key(i). */
function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const A = "11111111-aaaa-4aaa-8aaa-111111111111";
const B = "22222222-bbbb-4bbb-8bbb-222222222222";

// ── Ownership ────────────────────────────────────────────────────────────────
check("a signed-in user owns a namespaced bucket", ownerKeyFor(A) === `user:${A}`);
check("signed out falls back to the anonymous bucket", ownerKeyFor(null) === ANON_OWNER);
check("undefined is treated as signed out", ownerKeyFor(undefined) === ANON_OWNER);

check(
  "two accounts never share a bucket",
  conversationsStorageKey(ownerKeyFor(A)) !== conversationsStorageKey(ownerKeyFor(B)),
  "this is the check that would have caught the original leak",
);
check(
  "signing out does not land in either account's bucket",
  conversationsStorageKey(ANON_OWNER) !== conversationsStorageKey(ownerKeyFor(A)) &&
    conversationsStorageKey(ANON_OWNER) !== conversationsStorageKey(ownerKeyFor(B)),
);
check(
  "a uuid can never collide with the anonymous bucket",
  ownerKeyFor(ANON_OWNER) === `user:${ANON_OWNER}`,
  "namespacing means even a user literally named 'anon' stays separate",
);
check(
  "the same account returns to the same bucket",
  conversationsStorageKey(ownerKeyFor(A)) === conversationsStorageKey(ownerKeyFor(A)),
  "signing back in has to restore your own history, not a blank slate",
);

// ── Enumeration ──────────────────────────────────────────────────────────────
const store = fakeStorage({
  "nexus_convos_s_abc123": "[]", // legacy, browser-scoped
  "nexus_convos_s_def456": "[]", // legacy, browser-scoped
  [`nexus_convos_user:${A}`]: "[]",
  "nexus_convos_anon": "[]",
  "nexus_openai_key": "sk-not-a-conversation",
  "ucb_session": "s_abc123",
  "theme": "dark",
});

check("only conversation buckets are enumerated", conversationKeys(store).length === 4);
check(
  "unrelated keys are never touched",
  !conversationKeys(store).some((k) => k === "nexus_openai_key" || k === "theme"),
);

// ── Legacy purge ─────────────────────────────────────────────────────────────
const legacy = legacyConversationKeys(store);
check("both browser-scoped buckets are identified as legacy", legacy.length === 2);
check(
  "the owned bucket is NOT legacy",
  !legacy.includes(`nexus_convos_user:${A}`),
  "purging a signed-in user's own history would be data loss, not a fix",
);
check("the anonymous bucket is NOT legacy", !legacy.includes("nexus_convos_anon"));

const dropped = purgeLegacyConversations(store);
check("purge reports what it removed", dropped === 2);
check(
  "purge removed exactly the legacy buckets",
  store.getItem("nexus_convos_s_abc123") === null &&
    store.getItem("nexus_convos_s_def456") === null,
);
check(
  "purge left the owned and anonymous buckets intact",
  store.getItem(`nexus_convos_user:${A}`) === "[]" &&
    store.getItem("nexus_convos_anon") === "[]",
);
check(
  "purge left the API key and unrelated keys alone",
  store.getItem("nexus_openai_key") === "sk-not-a-conversation" &&
    store.getItem("theme") === "dark",
);
check("purging twice is a no-op", purgeLegacyConversations(store) === 0);
check("purging an empty store is safe", purgeLegacyConversations(fakeStorage()) === 0);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
