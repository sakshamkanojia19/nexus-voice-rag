/**
 * Speaker-echo defences for the live voice call.
 *
 * The mic stays open while the assistant talks so the user can barge in, which
 * means browser echo cancellation is the only thing between us and hearing
 * ourselves. On laptop speakers it leaks, STT decodes the leak, and the reply
 * becomes the next "user" turn — the assistant then talks to itself forever.
 *
 * Two independent filters guard that path, because each catches what the other
 * misses: `isLikelyAssistantEcho` matches against what was actually spoken, and
 * `isLowInformationBargeIn` rejects on shape when STT returns garbage that
 * resembles nothing at all. Both apply only while the assistant may be audible.
 *
 * Pure and dependency-free so the rules can be exercised directly.
 */

export function speechWords(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function comparableSpeechWord(word: string): string {
  return word
    .normalize("NFKC")
    // Hindi recognizers commonly alternate these equivalent short/long vowel
    // and nasal forms (for example "हूँ" versus "हूं").
    .replace(/[ँं]/g, "ं")
    .replace(/[ुू]/g, "ु")
    .replace(/[’']/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

function speechWordMatches(a: string, b: string): boolean {
  const left = comparableSpeechWord(a);
  const right = comparableSpeechWord(b);
  // 3 chars, not 4: speaker echo mangles short words just enough to slip a
  // stricter matcher — "hej" for "hey", "vad" for "bad".
  return left === right || (Math.min(left.length, right.length) >= 3 && editDistance(left, right) <= 1);
}

/**
 * How long after playback stops that audio can still be echo. It must outlast
 * the whole capture pipeline — VAD's trailing-silence window plus a Whisper
 * round-trip — or late-arriving echo is judged with the guard already expired.
 */
export const ECHO_TAIL_MS = 2500;

/** Words that must always interrupt, even alone and even mid-playback. */
export const INTERRUPTION_COMMANDS = new Set([
  "stop", "wait", "pause", "cancel", "no", "listen", "wrong", "actually", "hold", "enough",
  "रुको", "रुकिए", "बस", "नहीं", "मत", "सुनो", "गलत",
]);

/**
 * A real barge-in is a phrase; speaker echo that survives the matcher is almost
 * always one mangled fragment ("hej", "edge", "čveč"). While the assistant is
 * audible we therefore refuse to interrupt on a lone non-command word — the
 * echo matcher can't help when the fragment resembles nothing that was said.
 */
export function isLowInformationBargeIn(candidate: string): boolean {
  const words = speechWords(candidate);
  if (words.length === 0) return true;
  if (words.some((word) => INTERRUPTION_COMMANDS.has(word))) return false;
  return words.length === 1;
}

/** Split a transcript into sentences, keeping trailing punctuation. Handles the
 *  terminators Whisper emits across the app's languages (Latin + Devanagari). */
function sentences(text: string): string[] {
  return (text.match(/[^.!?…।]+[.!?…।]*/gu) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** Share of a sentence's words that also occur (fuzzily) in the assistant's
 *  reply. 1.0 means every word the user "said" was a word we just spoke. */
function overlapRatio(sentenceWords: string[], answer: string[]): number {
  if (sentenceWords.length === 0) return 0;
  const matching = sentenceWords.filter((word) =>
    answer.some((answerWord) => speechWordMatches(word, answerWord)),
  ).length;
  return matching / sentenceWords.length;
}

/** A sentence must be at least this echo-like to be cut from a mixed
 *  transcript. Higher than the whole-transcript threshold in
 *  `isLikelyAssistantEcho` (0.75): removing part of what the user said is a
 *  worse mistake than letting a whole suspect turn through, so each cut needs
 *  stronger evidence. */
const SENTENCE_ECHO_OVERLAP = 0.8;
/** Below this many words a sentence is judged by the stricter whole-transcript
 *  filters instead — two words can overlap by accident far too easily. */
const SENTENCE_ECHO_MIN_WORDS = 4;

/**
 * Cut the assistant's own sentences out of a MIXED transcript.
 *
 * The worst echo failure is not a transcript that is pure echo — the filters
 * above catch that. It is a barge-in: the user starts talking while the
 * assistant is still audible, VAD opens one segment over both voices, and
 * Whisper faithfully transcribes the assistant's sentences followed by the
 * user's. `isLikelyAssistantEcho` then scores the mix below its threshold
 * (most of the words ARE the user's), the whole thing is submitted as the
 * user's turn, and the conversation history now shows the user saying the
 * assistant's lines — which is exactly what makes the model lose the thread
 * of the conversation.
 *
 * The defence is sentence-level: a sentence nearly all of whose words were in
 * the reply being played is the reply, and is cut; everything else survives.
 * Sentences carrying an interruption command always survive. Returns the
 * transcript with echo sentences removed — possibly "" when every sentence
 * matched, which callers should treat as pure echo.
 */
export function stripAssistantEcho(candidate: string, assistant: string): string {
  const answer = speechWords(assistant);
  if (!answer.length) return candidate;
  const parts = sentences(candidate);
  if (parts.length <= 1) return candidate; // whole-transcript filters own this case
  const answerText = answer.join(" ");

  const kept = parts.filter((sentence) => {
    const words = speechWords(sentence);
    if (words.length === 0) return false;
    if (words.some((word) => INTERRUPTION_COMMANDS.has(word))) return true;
    // An exact run of our own words is echo at any length.
    if (words.length >= 2 && answerText.includes(words.join(" "))) return false;
    if (words.length < SENTENCE_ECHO_MIN_WORDS) return true;
    return overlapRatio(words, answer) < SENTENCE_ECHO_OVERLAP;
  });

  if (kept.length === parts.length) return candidate;
  return kept.join(" ").trim();
}

/** Browser echo cancellation is imperfect with laptop speakers. Reject STT
 * that matches the answer currently being spoken, while preserving explicit
 * one-word interruption commands. */
export function isLikelyAssistantEcho(candidate: string, assistant: string): boolean {
  const heard = speechWords(candidate);
  const answer = speechWords(assistant);
  if (!heard.length || !answer.length) return false;

  if (heard.some((word) => INTERRUPTION_COMMANDS.has(word))) return false;

  const heardText = heard.join(" ");
  const answerText = answer.join(" ");
  if (answerText.includes(heardText) || answer.slice(0, heard.length).join(" ") === heardText) return true;

  const matchingWords = heard.filter((word) => answer.some((answerWord) => speechWordMatches(word, answerWord))).length;
  if (heard.length === 1) return matchingWords === 1;
  return matchingWords / heard.length >= 0.75;
}

/** Minimum words that must survive a prefix cut for the remainder to be worth
 *  submitting. Below this it is a fragment, not a question. */
const PREFIX_STRIP_MIN_REMAINDER = 3;

/** Shortest run of our own words that counts as an echo prefix rather than the
 *  user happening to open with a word we also used. */
const ECHO_PREFIX_MIN_WORDS = 3;

/**
 * Cut a leading run of the assistant's own words off an UNPUNCTUATED
 * transcript.
 *
 * `stripAssistantEcho` works sentence by sentence and gives up when there is
 * only one sentence to work with — which is every interim result Chrome's Web
 * Speech recognizer produces, because it emits no punctuation. That is the
 * exact shape a barge-in takes on that path: the recognizer was already
 * running when our reply started leaking through the speakers, so it hands
 * back one unbroken string of our words followed by the user's, e.g.
 *
 *   "how can i assist you today can you tell me about what is pizza"
 *    └──────── our reply ───────┘└─────────── the user ───────────┘
 *
 * Discarding that whole string as echo throws away the question, and the user
 * gets an assistant that answers something they never asked. So: walk forward
 * while each word is one the assistant just said, and keep the remainder.
 *
 * Deliberately prefix-only. A word of ours appearing in the MIDDLE of the
 * user's sentence is far more likely a coincidence — "pizza" said by both — and
 * cutting there would mangle real speech. Returns the input unchanged when
 * there is no echo prefix, or when too little would survive to be a question.
 */
export function stripAssistantEchoPrefix(candidate: string, assistant: string): string {
  const heard = speechWords(candidate);
  const answer = speechWords(assistant);
  if (heard.length < 2 || !answer.length) return candidate;

  // Longest prefix of the candidate that appears as a CONTIGUOUS run in the
  // reply. Walking word-by-word while each one merely occurs somewhere in the
  // reply over-cuts badly: after "how can i assist you today" the user's own
  // "can you tell me…" keeps matching, because "can" and "you" are both in the
  // greeting, and the question loses its first two words. Contiguity is what
  // distinguishes our sentence from their vocabulary overlapping ours.
  const answerText = ` ${answer.join(" ")} `;
  let cut = 0;
  for (let n = Math.min(heard.length - 1, answer.length); n >= ECHO_PREFIX_MIN_WORDS; n--) {
    if (answerText.includes(` ${heard.slice(0, n).join(" ")} `)) {
      cut = n;
      break;
    }
  }

  // Nothing echoed, or the whole thing did — both are somebody else's job:
  // the first is not echo at all, the second is what the whole-transcript
  // filters already reject.
  if (cut === 0 || cut === heard.length) return candidate;
  if (heard.length - cut < PREFIX_STRIP_MIN_REMAINDER) return candidate;

  // Re-slice the ORIGINAL text rather than rejoining normalised words, so the
  // user's casing and punctuation reach the model as they were recognised.
  const tokens = candidate.match(/\S+/g) ?? [];
  if (tokens.length !== heard.length) return heard.slice(cut).join(" ");
  return tokens.slice(cut).join(" ");
}
