// Exercises the real src/lib/echo.ts against the transcripts from the console
// log, plus the barge-ins that must still get through.
import { isLikelyAssistantEcho, isLowInformationBargeIn, stripAssistantEcho, stripAssistantEchoPrefix } from "./echo.ts";

// What the assistant was saying when each fragment came back from STT.
const SPOKEN = "Hej! Nova här, vad kan jag hjälpa dig med idag?";
const SPOKEN_EN = "Hey! I'm doing great, thanks for asking. What can I help you with today?";

/** The app blocks a turn if EITHER filter rejects it (assistant audible). */
const blocked = (text, spoken) =>
  isLowInformationBargeIn(text) || isLikelyAssistantEcho(text, spoken);

const cases = [
  // ── Echo fragments straight from the log — all must be BLOCKED ──
  ["hej", SPOKEN_EN, true],
  ["Hej.", SPOKEN, true],
  ["edge", SPOKEN_EN, true],
  ["Hach", SPOKEN, true],
  ["hej.", SPOKEN_EN, true],
  ["čveč.", SPOKEN, true],
  // These two only read as echo against the reply that contained them, which
  // is what latestAssistantText() returns at that moment in the real app.
  ["Hey there.", "Hey there. I'm Nexus — how can I help you today?", true],
  ["or something else.", "Did you want the summary, or something else.", true],
  ["Hej! Nova här,", SPOKEN, true],
  ["vad kan jag hjälpa dig med idag?", SPOKEN, true],

  // ── Real user speech — all must PASS ──
  ["stop", SPOKEN_EN, false],
  ["wait", SPOKEN_EN, false],
  ["no, that's wrong", SPOKEN_EN, false],
  ["what is the capital of France", SPOKEN_EN, false],
  ["can you summarise my document", SPOKEN_EN, false],
  ["tell me more about quantum computing", SPOKEN_EN, false],
  ["how does blockchain work", SPOKEN_EN, false],
  // Short but genuine barge-ins that share no wording with the reply.
  ["different question", SPOKEN_EN, false],
  ["actually never mind", SPOKEN_EN, false],
];

let failed = 0;
for (const [text, spoken, shouldBlock] of cases) {
  const got = blocked(text, spoken);
  const ok = got === shouldBlock;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${shouldBlock ? "block" : "allow"}  ${JSON.stringify(text)}` +
      (ok ? "" : `   → got ${got ? "blocked" : "allowed"}`),
  );
}

// ── stripAssistantEcho: MIXED transcripts from a real barge-in session ───────
// The mic heard the assistant's reply through the speakers, then the user.
// Whisper transcribed both; the assistant's sentences must be cut, the user's
// kept. These are lightly-paraphrased captures from the 2026-08-09 session.

const REPLY_DIAL =
  "Hey! Looks like you said \"dial\" — could you tell me a bit more about what you mean? " +
  "Are you asking about dialing a phone number, a dial in a machine, or something else? Just let me know!";
const REPLY_WHITE_DIAL =
  "Got it! When you say \"white dial\" in a watch, you're talking about the face of the watch being white in color. " +
  "The dial is the part where the numbers or markers and the hands sit, showing the time. " +
  "A white dial watch usually looks clean, classic, and versatile — great for both casual and formal styles. " +
  "Are you looking for recommendations on white dial watches, or details about specific brands or features?";
const REPLY_WIDE =
  "Let me know so I can zero in on the best wide dial options for you.";

const stripCases = [
  // [mixed transcript, assistant reply, what must survive]
  [
    "Just like you said dial, could you tell me a bit more about what you mean? I said white dial. " +
      "Are you asking about dialing a phone number, a dial in a machine, or something else? Just let me know. " +
      "I said white dial in watch that I am looking.",
    REPLY_DIAL,
    ["I said white dial", "watch that I am looking"],
    ["phone number", "a dial in a machine"],
  ],
  [
    "When you say white dial in a watch, you're talking about the face of the watch being white in color. " +
      "Hello Nexus. out of topic. I told you that I was looking for 5000 budget watches but you are off the topic right now.",
    REPLY_WHITE_DIAL,
    ["5000 budget watches", "off the topic"],
    ["face of the watch being white"],
  ],
  [
    "Let me know so I can zero in on the best wide-dial options for you. Actually, I am looking analog watches, chronograph watches.",
    REPLY_WIDE,
    ["analog watches", "chronograph"],
    ["zero in on the best"],
  ],
  // Clean user speech that shares topic words must survive UNTOUCHED.
  [
    "I want a white dial watch under 5000. Show me some brands.",
    REPLY_WHITE_DIAL,
    ["white dial watch under 5000", "Show me some brands"],
    [],
  ],
];

for (const [mixed, reply, mustKeep, mustCut] of stripCases) {
  const out = stripAssistantEcho(mixed, reply);
  const problems = [
    ...mustKeep.filter((s) => !out.includes(s)).map((s) => `lost ${JSON.stringify(s)}`),
    ...mustCut.filter((s) => out.includes(s)).map((s) => `kept ${JSON.stringify(s)}`),
  ];
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  strip  ${JSON.stringify(mixed.slice(0, 60))}…` +
      (ok ? "" : `   → ${problems.join("; ")}   out=${JSON.stringify(out)}`),
  );
}

// Pure echo — every sentence matches — must come back empty.
{
  const out = stripAssistantEcho(
    "Are you asking about dialing a phone number, a dial in a machine, or something else? Just let me know!",
    REPLY_DIAL,
  );
  const ok = out.trim() === "";
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  strip  pure echo returns empty` + (ok ? "" : `   → ${JSON.stringify(out)}`));
}

// ── stripAssistantEchoPrefix ─────────────────────────────────────
// Captured from a real session: Chrome's recognizer was already running when
// the reply began leaking through the speakers, so it returned ONE unpunctuated
// string — the assistant's words followed by the user's. stripAssistantEcho
// bails on single-sentence input, so the whole utterance was discarded as echo
// and the question with it; the assistant then asked "could you remind me what
// 'it' is?" about a pizza question it had never received.
{
  const GREETING = "Hi! I'm here and ready to help. How can I assist you today?";
  const cases = [
    {
      name: "real capture: pizza question glued to our greeting",
      mixed: "how can i assist you today can you tell me about what is pizza and how it be",
      spoken: GREETING,
      expect: "can you tell me about what is pizza and how it be",
    },
    {
      name: "no echo prefix is left alone",
      mixed: "what is chocolate made of",
      spoken: GREETING,
      expect: "what is chocolate made of",
    },
    {
      name: "pure echo left for the whole-transcript filters",
      mixed: "how can i assist you today",
      spoken: GREETING,
      expect: "how can i assist you today",
    },
    {
      name: "a scrap surviving the cut is not a question",
      mixed: "how can i assist you today ok",
      spoken: GREETING,
      expect: "how can i assist you today ok",
    },
    {
      name: "casing and punctuation survive the cut",
      mixed: "How can I assist you today Tell me about Pizza, please?",
      spoken: GREETING,
      expect: "Tell me about Pizza, please?",
    },
  ];
  for (const { name, mixed, spoken, expect } of cases) {
    const out = stripAssistantEchoPrefix(mixed, spoken);
    const ok = out === expect;
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  prefix  ${name}` +
        (ok ? "" : `   → got ${JSON.stringify(out)} want ${JSON.stringify(expect)}`),
    );
  }
}

console.log(`\n${failed === 0 ? "all echo checks passed" : failed + " failed"}`);

process.exit(failed ? 1 : 0);
