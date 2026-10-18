// Exercises the real src/lib/endpointing.ts.
//
// The property that matters: someone who pauses mid-thought must NOT be cut
// off, and someone who has finished must NOT be left waiting. Those pull in
// opposite directions, so both are tested on the same rule set.
import {
  ENDPOINT_COMPLETE_MS,
  ENDPOINT_COMPLETE_RISING_MS,
  ENDPOINT_CONTINUING_MS,
  ENDPOINT_FALLING_MS,
  ENDPOINT_RISING_MS,
  ENDPOINT_UNCLEAR_MS,
  applyProsody,
  cleanTranscript,
  collapseStutters,
  isOnlyFiller,
  judgeEndpoint,
  words,
} from "./endpointing.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

// ── Must keep listening: the user is mid-thought ───────────────────────────
// Every one of these is a real way people trail off while thinking.
const CONTINUING = [
  "i want to know what is",          // from the user's own console logs
  "can you tell me about",           // ditto
  "tell me about the",
  "so i was thinking about the",
  "what is the capital of",
  "my question is about, um",
  "i need to find the, uh",
  "the thing is",                     // trailing "is"
  "and then",
  "because",
  "hmm",
  "um",
  "uh so",
  "let me think, so",
  "i wanted to ask you about how",
  "give me",
  "show me the",
  "compare this with",
  "what about",
  "it depends on whether",
  "explain",                          // single verb, nothing to explain yet
  "elon",                             // one word — a name, not a question
  "elon musk",                        // two words — still probably the subject
  "can you",                          // subject pronoun, verb still to come
  "hello nexus what is the",          // a greeting skipped must not hide a dangling end
  "i was wondering if you",
  "do you",
  "and it",
  // Hindi mid-clause endings
  "मुझे बताओ कि",
  "यह किसके",
];

for (const text of CONTINUING) {
  const d = judgeEndpoint(text);
  check(
    `keep listening: ${JSON.stringify(text)}`,
    d.completeness === "continuing" && d.waitMs === ENDPOINT_CONTINUING_MS,
    `${d.completeness} / ${d.waitMs}ms (${d.reason})`,
  );
}

// ── Must finish promptly: the user is done ─────────────────────────────────
const COMPLETE = [
  "What is the capital of France?",
  "Tell me about Elon Musk.",
  "what is the total revenue of tesla",   // question, no punctuation
  "how does photosynthesis actually work",
  "how are you doing today nexus",
  "hello nexus how are you",              // greeting before the question (user's console)
  "what is THAAD",                         // interrogative + copula + subject
  "hey what is RAG",
  "yes",
  "no",
  "stop",
  "thanks",
  "never mind",
  "हाँ",
  "नहीं",
];

for (const text of COMPLETE) {
  const d = judgeEndpoint(text);
  check(
    `finish promptly: ${JSON.stringify(text)}`,
    d.completeness === "complete" && d.waitMs === ENDPOINT_COMPLETE_MS,
    `${d.completeness} / ${d.waitMs}ms (${d.reason})`,
  );
}

// ── No strong signal: a moderate wait, never a snap judgement ──────────────
const UNCLEAR = [
  "i just wanted to thank you",
  "i will talk to you",
  "i went to the store yesterday",
  "the report says revenue grew",
];

// Hindi is verb-final, so a trailing copula/verb closes the clause — the exact
// opposite of the English auxiliaries in the dangling list.
for (const text of ["मैं आज बाजार गया था", "यह बहुत अच्छा है", "मुझे इसके बारे में बताओ"]) {
  const d = judgeEndpoint(text);
  check(
    `Hindi sentence-final verb completes: ${JSON.stringify(text)}`,
    d.completeness === "complete",
    `${d.completeness} (${d.reason})`,
  );
}

for (const text of UNCLEAR) {
  const d = judgeEndpoint(text);
  check(
    `moderate wait: ${JSON.stringify(text)}`,
    d.completeness === "unclear" && d.waitMs === ENDPOINT_UNCLEAR_MS,
    `${d.completeness} / ${d.waitMs}ms (${d.reason})`,
  );
}

// ── Ordering invariants ────────────────────────────────────────────────────
check(
  "a continuing utterance always waits longest",
  ENDPOINT_CONTINUING_MS > ENDPOINT_UNCLEAR_MS && ENDPOINT_UNCLEAR_MS > ENDPOINT_COMPLETE_MS,
);
check(
  "the thinking window is in the 3-5s range the design calls for",
  ENDPOINT_CONTINUING_MS >= 3000 && ENDPOINT_CONTINUING_MS <= 5000,
  `${ENDPOINT_CONTINUING_MS}ms`,
);
check(
  "a filler outranks punctuation the recognizer invented",
  judgeEndpoint("So, um.").completeness === "continuing",
  judgeEndpoint("So, um.").reason,
);
check(
  "a dangling word outranks punctuation too",
  judgeEndpoint("I want to know about the.").completeness === "continuing",
  judgeEndpoint("I want to know about the.").reason,
);
check("empty input never claims completeness", judgeEndpoint("").completeness === "unclear");
check("whitespace-only input is handled", judgeEndpoint("   ").completeness === "unclear");
check("judgeEndpoint never returns a non-positive wait",
  [...CONTINUING, ...COMPLETE, ...UNCLEAR, "", "  "].every((t) => judgeEndpoint(t).waitMs > 0));

// ── Filler-only detection ──────────────────────────────────────────────────
for (const t of ["um", "uh", "hmm", "um uh", "so um", "  ummm  "]) {
  check(`filler-only: ${JSON.stringify(t)}`, isOnlyFiller(t));
}
for (const t of ["um what", "hello", "so tell me", ""]) {
  check(`not filler-only: ${JSON.stringify(t)}`, !isOnlyFiller(t));
}

// ── Stutter collapsing ─────────────────────────────────────────────────────
const STUTTERS = [
  ["the the the report", "the report"],
  ["I I want to know", "I want to know"],
  ["can can you tell me", "can you tell me"],
  ["what what what is this", "what is this"],
  ["The the report", "The report"],           // case-insensitive match
  ["no repeats here", "no repeats here"],     // untouched
  ["", ""],
  ["that that he said that", "that he said that"], // only immediate repeats
];
for (const [input, want] of STUTTERS) {
  const got = collapseStutters(input);
  check(`collapse ${JSON.stringify(input)}`, got === want, JSON.stringify(got));
}
check(
  "collapsing never lengthens the text",
  STUTTERS.every(([input]) => collapseStutters(input).length <= input.length),
);

// ── Disfluency cleanup: what was said → what was meant ────────────────────
const CLEANUPS = [
  // Straight from the console logs and ordinary speech.
  ["um, so I want to know about Tesla", "so I want to know about Tesla"],
  ["uh tell me about Elon Musk", "tell me about Elon Musk"],
  ["I I want to know the revenue", "I want to know the revenue"],
  ["the um the report says", "the report says"],          // filler between repeats
  ["what, uh, is the capital of France?", "what is the capital of France?"],
  ["hmm let me think, what is AI", "let me think, what is AI"],
  ["you know, it depends", "it depends"],
  ["I mean tell me more", "tell me more"],
  ["can can can you help", "can you help"],
  ["ahh yes that one", "yes that one"],
  ["mm hmm okay go on", "okay go on"],
  // A mid-sentence "so" is meaningful and must survive.
  ["so I asked her about it", "so I asked her about it"],
  // Nothing to do.
  ["tell me about quantum computing", "tell me about quantum computing"],
  ["", ""],
];
for (const [input, want] of CLEANUPS) {
  const got = cleanTranscript(input);
  check(`clean ${JSON.stringify(input)}`, got === want, JSON.stringify(got));
}

check(
  "cleanup never leaves doubled spaces",
  CLEANUPS.every(([input]) => !/\s{2,}/.test(cleanTranscript(input))),
);
check(
  "cleanup never leaves a leading or orphaned comma",
  CLEANUPS.every(([input]) => {
    const out = cleanTranscript(input);
    return !/^[,;]/.test(out) && !/\s[,;](\s|$)/.test(out);
  }),
);
check(
  "cleanup never lengthens the transcript",
  CLEANUPS.every(([input]) => cleanTranscript(input).length <= input.length),
);
check(
  "a filler-only utterance cleans to nothing",
  ["um", "uh", "hmm", "um uh", "ahh"].every((t) => cleanTranscript(t) === ""),
);

// ── words() ────────────────────────────────────────────────────────────────
check("words strips punctuation", JSON.stringify(words("Hello, world!")) === '["hello","world"]');
check("words keeps apostrophes", JSON.stringify(words("don't")) === '["don\'t"]');
check("words handles Devanagari", words("मुझे बताओ").length === 2);

// ── Prosody ────────────────────────────────────────────────────────────────
// Intonation is allowed to break ties the words could not, and nothing more.
// These checks pin down both halves of that: that it decides `unclear`, and
// that it cannot touch a decision the transcript already made confidently.

const CONTOURS = ["falling", "rising", "level", "unknown"];

// Default argument: every existing caller and every test above must be
// unaffected by the new parameter.
check(
  "judgeEndpoint with no contour matches the unknown contour",
  ["what is the capital of france", "tell me about", "yes", "um"].every(
    (t) => JSON.stringify(judgeEndpoint(t)) === JSON.stringify(judgeEndpoint(t, "unknown")),
  ),
);
check(
  "an unknown or level contour changes nothing",
  ["what is the capital of france", "i went to the store yesterday", "tell me about"].every((t) =>
    ["unknown", "level"].every(
      (c) => JSON.stringify(judgeEndpoint(t, c)) === JSON.stringify(judgeEndpoint(t)),
    ),
  ),
);

// The load-bearing safety property. "…tell me about" cannot end a sentence, and
// no pitch reading may be allowed to argue otherwise — overruling grammar here
// is exactly the mid-sentence cut-off the module exists to prevent.
{
  const dangling = ["tell me about", "i want to know the", "show me elon musk and"];
  check(
    "a grammatically impossible ending is never shortened by prosody",
    dangling.every((t) =>
      CONTOURS.every((c) => {
        const d = judgeEndpoint(t, c);
        return d.completeness === "continuing" && d.waitMs === ENDPOINT_CONTINUING_MS;
      }),
    ),
  );
  check(
    "a trailing filler is never shortened by prosody",
    CONTOURS.every((c) => judgeEndpoint("so i was thinking um", c).waitMs === ENDPOINT_CONTINUING_MS),
  );
}

// Where prosody is actually allowed to decide.
{
  const unclear = judgeEndpoint("i went to the store yesterday");
  check("the test sentence is genuinely unclear", unclear.completeness === "unclear", unclear.reason);

  const falling = judgeEndpoint("i went to the store yesterday", "falling");
  check(
    "unclear + falling pitch resolves to complete",
    falling.completeness === "complete" && falling.waitMs === ENDPOINT_FALLING_MS,
    `${falling.completeness} @ ${falling.waitMs}ms`,
  );
  check("…and that is faster than waiting it out", ENDPOINT_FALLING_MS < ENDPOINT_UNCLEAR_MS);

  const rising = judgeEndpoint("i went to the store yesterday", "rising");
  check(
    "unclear + rising pitch resolves to continuing",
    rising.completeness === "continuing" && rising.waitMs === ENDPOINT_RISING_MS,
    `${rising.completeness} @ ${rising.waitMs}ms`,
  );
  check(
    "…and that holds longer than the neutral wait, but short of a full think",
    ENDPOINT_UNCLEAR_MS < ENDPOINT_RISING_MS && ENDPOINT_RISING_MS < ENDPOINT_CONTINUING_MS,
  );
}

// A finished-looking sentence said with a rising voice gets grace, not a hold:
// staying `complete` is what keeps the "understanding" indicator from flashing
// for a fraction of a second on every other turn.
{
  const d = judgeEndpoint("what is the capital of france?", "rising");
  check(
    "complete + rising pitch extends the wait but stays complete",
    d.completeness === "complete" && d.waitMs === ENDPOINT_COMPLETE_RISING_MS,
    `${d.completeness} @ ${d.waitMs}ms`,
  );
  check("complete + falling pitch keeps the snappy wait", judgeEndpoint("what is the capital of france?", "falling").waitMs === ENDPOINT_COMPLETE_MS);
}

// Prosody must never make a confident decision slower than it already was.
check(
  "prosody never delays an already-complete verdict below its own floor",
  ["yes", "what is the capital of france?", "मुझे बताओ है क्या"].every((t) =>
    CONTOURS.every((c) => judgeEndpoint(t, c).waitMs >= ENDPOINT_COMPLETE_MS),
  ),
);

// An empty transcript is an ABSENCE of evidence, not ambiguous evidence, and
// prosody must not be allowed to rule on it. This is a regression test for a
// real failure: with Chrome's speech service unreachable the transcript is
// empty on every turn, and letting the contour decide turned the endpointer
// into a pure pitch detector — finalizing every 900ms on a falling voice,
// re-opening, and never assembling a turn.
{
  const EMPTY = ["", "   ", "\n\t "];
  check(
    "an empty transcript ignores prosody entirely",
    EMPTY.every((t) =>
      CONTOURS.every(
        (c) => JSON.stringify(judgeEndpoint(t, c)) === JSON.stringify(judgeEndpoint(t)),
      ),
    ),
  );
  check(
    "an empty transcript never finalizes on a falling voice",
    EMPTY.every((t) => judgeEndpoint(t, "falling").completeness !== "complete"),
    JSON.stringify(judgeEndpoint("", "falling")),
  );
  check(
    "an empty transcript keeps its full neutral wait",
    EMPTY.every((t) => judgeEndpoint(t, "falling").waitMs === ENDPOINT_UNCLEAR_MS),
  );
  // …but one real word is enough to make the contour meaningful again.
  check(
    "a transcript with actual words still consults prosody",
    judgeEndpoint("i went to the store yesterday", "falling").waitMs === ENDPOINT_FALLING_MS,
  );
}

// applyProsody is pure: it must not mutate the decision handed to it.
{
  const base = { waitMs: ENDPOINT_UNCLEAR_MS, completeness: "unclear", reason: "no strong signal" };
  const snapshot = JSON.stringify(base);
  applyProsody(base, "falling");
  check("applyProsody does not mutate its input", JSON.stringify(base) === snapshot);
}

check(
  "the reason string records that prosody was involved",
  judgeEndpoint("i went to the store yesterday", "falling").reason.includes("falling pitch"),
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
