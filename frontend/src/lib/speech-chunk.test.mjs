// Verifies the streamed-TTS opening-clause cut: it must be a literal prefix
// (the stream position advances by its length), long enough to sound
// deliberate, and never fire while the buffer is still tiny.
import { OPENER_MAX_CHARS, OPENER_MIN_CHARS, openingClause } from "./speech-chunk.ts";

const cases = [
  // [buffer, expected opener ("" = stay silent and keep buffering)]
  ["Sure", ""],
  ["Cool idea! To build", ""],
  ["To build a chatbot like that you", ""],

  // Comma boundary past the minimum → cut there, keeping the comma.
  [
    "To build a chatbot like that, you'd want to start by defining its purpose",
    "To build a chatbot like that,",
  ],
  // Dash counts as a clause boundary too.
  [
    "Quantum computing is genuinely strange — a qubit holds both values at once",
    "Quantum computing is genuinely strange —",
  ],
  // Boundaries below the floor are ignored — "Right," alone sounds clipped, so
  // keep buffering rather than speak a fragment.
  ["Right, so first, you pick a framework", ""],
  // Last boundary within range wins, so the opener is as long as it can be.
  [
    "Well, the honest answer is that it depends, and mostly on your data",
    "Well, the honest answer is that it depends,",
  ],
  // No boundary at all → fall back to a word cut once long enough.
  [
    "The quick brown fox jumps over the lazy dog and keeps running across the whole field until it reaches the far fence",
    null, // checked structurally below
  ],
];

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
};

for (const [buffer, expected] of cases) {
  const got = openingClause(buffer);
  if (expected === null) {
    check(`word-boundary fallback on ${JSON.stringify(buffer.slice(0, 24))}…`,
      got.length >= OPENER_MIN_CHARS && got.length <= OPENER_MAX_CHARS && !got.endsWith(" "));
  } else {
    check(`${JSON.stringify(buffer.slice(0, 34))}… → ${JSON.stringify(expected)}`, got === expected);
  }
}

// Structural invariants across many buffer lengths — a non-prefix result would
// desynchronise the stream position and duplicate or drop speech.
const long =
  "Right so the first thing to do, honestly, is pick a framework; after that you train it, test it, and ship it.";
for (let n = 1; n <= long.length; n++) {
  const got = openingClause(long.slice(0, n));
  if (got && !long.slice(0, n).startsWith(got)) {
    check(`prefix invariant at length ${n}`, false);
    break;
  }
  if (got && got.length > OPENER_MAX_CHARS) {
    check(`max-length invariant at length ${n}`, false);
    break;
  }
  if (n < OPENER_MIN_CHARS && got !== "") {
    check(`silence-below-minimum invariant at length ${n}`, false);
    break;
  }
}
check("prefix / max-length / minimum invariants across all buffer lengths", true);

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed ? 1 : 0);
