// Exercises the real src/lib/apiKey.ts. The format check is what stops a
// malformed key being sent on every single request (the server 400s it), and
// the mask is what appears on screen — it must never be enough to use.
import { detectProvider, isValidKeyFormat, loadApiKey, maskKey, saveApiKey } from "./apiKey.ts";

// Minimal localStorage so the module under test runs outside a browser.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

const VALID = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const VALID_PROJ = "sk-proj-AbC123_def-456ghiJKL789mnopqrst";
const XAI = "xai-" + "A1b2C3d4E5f6G7h8".repeat(5);
const GROQ = "gsk_" + "Z9y8X7w6V5u4T3s2".repeat(3);

// ── Format ─────────────────────────────────────────────────────────────────
for (const [key, want] of [
  [VALID, true],
  [VALID_PROJ, true],
  [XAI, true],
  [GROQ, true],
  ["xai-short", false],
  ["gsk_short", false],
  [`gsk-${"a".repeat(40)}`, false],  // wrong separator: Groq uses an underscore
  [`  ${VALID}  `, true],          // pasted with whitespace
  ["sk-short", false],
  ["sk-", false],
  ["", false],
  ["not-a-key-at-all-but-quite-long", false],
  [`Bearer ${VALID}`, false],       // a pasted header
  [`sk-abc def${"g".repeat(20)}`, false], // internal space
  [`sk-${"a".repeat(300)}`, false],  // absurd length
]) {
  check(
    `${want ? "accept" : "reject"}  ${JSON.stringify(key.slice(0, 28))}`,
    isValidKeyFormat(key) === want,
  );
}

// ── Provider detection — must agree with backend/providers.py ──────────────
check("an sk- key is OpenAI", detectProvider(VALID)?.id === "openai");
check("an xai- key is xAI", detectProvider(XAI)?.id === "xai");
check("a gsk_ key is Groq", detectProvider(GROQ)?.id === "groq");
check("a malformed key has no provider", detectProvider("garbage") === null);
check("no key has no provider", detectProvider(null) === null);
check("only OpenAI keys can upload documents",
  detectProvider(VALID)?.documents === true &&
  detectProvider(XAI)?.documents === false &&
  detectProvider(GROQ)?.documents === false);

// ── Masking ────────────────────────────────────────────────────────────────
{
  const masked = maskKey(VALID);
  check("mask keeps a recognisable prefix and suffix", masked === "sk-abc…6789", masked);
  check("mask never contains the whole key", !masked.includes(VALID));
  check(
    "mask drops the overwhelming majority of the key",
    masked.replace("…", "").length < VALID.length / 2,
    `${masked.length} of ${VALID.length} chars`,
  );
  check("mask handles a short/degenerate value without throwing", maskKey("sk-x") === "sk-…");
  check("mask handles an empty value", maskKey("") === "sk-…");
  check("mask hides an xAI key", !maskKey(XAI).includes(XAI.slice(6, -4)));
  check("mask keeps a short key's own prefix", maskKey("gsk_x") === "gsk_…");
}

saveApiKey(GROQ);
check("a Groq key round-trips", loadApiKey() === GROQ);

// ── Round trip ─────────────────────────────────────────────────────────────
store.clear();
check("nothing stored reads back as null", loadApiKey() === null);

saveApiKey(VALID);
check("a valid key round-trips", loadApiKey() === VALID);

saveApiKey(`  ${VALID_PROJ}  `);
check("a key is trimmed before storage", loadApiKey() === VALID_PROJ);

saveApiKey(null);
check("clearing removes the key", loadApiKey() === null);

// A malformed value must never be persisted...
saveApiKey("garbage");
check("a malformed key is not persisted", loadApiKey() === null);

// ...and one that somehow got there is treated as absent, not sent. Otherwise
// every request carries it and 400s.
store.set("nexus_openai_key", "corrupted-value");
check("a corrupted stored value reads back as null", loadApiKey() === null);

// ── Storage unavailable (private mode, blocked cookies) ────────────────────
{
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  let threw = false;
  try {
    saveApiKey(VALID);
    check("load returns null when storage is blocked", loadApiKey() === null);
  } catch {
    threw = true;
  }
  check("blocked storage never throws into the caller", !threw);
  globalThis.localStorage = real;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
