/**
 * When has the user actually finished speaking?
 *
 * Acoustic silence is a bad answer to that question on its own. People pause
 * mid-thought — to remember a name, to decide how to phrase something, to
 * breathe — and a fixed silence threshold cannot tell that apart from the end
 * of a turn. Set it short and you interrupt people constantly; set it long and
 * every exchange drags. Neither is what a good listener does.
 *
 * A human listener uses the *content* of what was said. "What's the capital of"
 * is obviously unfinished no matter how long the silence that follows; "What's
 * the capital of France?" is obviously finished after a beat. This module makes
 * the same judgement from the transcript, and returns how long to keep the
 * microphone open before deciding the turn is over.
 *
 * Three outcomes:
 *
 *   complete    the utterance stands on its own — a short, snappy wait
 *   continuing  it grammatically cannot be the end (dangling conjunction,
 *               preposition, article, or a trailing "um") — a long wait, so
 *               the user can think without being cut off
 *   unclear     no strong signal either way, including any language whose
 *               function words we do not model — a moderate wait
 *
 * The lists below are English and Hindi, matching the languages the app ships
 * with. An unrecognised language degrades to `unclear`, which is a moderate
 * wait rather than a wrong guess in either direction — deliberately, because
 * being confidently wrong about "complete" is what interrupts people.
 *
 * Words alone have a ceiling, though, and `unclear` is where it shows: most
 * real sentences are neither grammatically impossible nor punctuated, so they
 * land in the middle bucket and get a compromise wait that is too long for
 * someone who has finished and too short for someone who has not. `prosody.ts`
 * resolves that from intonation — see `applyProsody` at the bottom of this file
 * for exactly how far it is allowed to move the answer.
 *
 * Pure and dependency-free so the rules can be exercised directly.
 */

import type { ProsodyContour } from "./prosody";

// ── Timings ─────────────────────────────────────────────────────────────────
/** Wait after an utterance that reads as finished. Short enough to feel
 *  immediate; not zero, because recognizers sometimes finalize mid-sentence. */
export const ENDPOINT_COMPLETE_MS = 700;
/** Wait when there is no strong signal either way. */
export const ENDPOINT_UNCLEAR_MS = 1600;
/** Wait when the utterance cannot be the end of a sentence. This is the "let me
 *  think" window — long on purpose, and only ever reached when the words
 *  themselves say more is coming. */
export const ENDPOINT_CONTINUING_MS = 4000;

/** Words gave no verdict but the voice dropped away: treat as finished. Slightly
 *  longer than `ENDPOINT_COMPLETE_MS` because a contour is softer evidence than
 *  a full stop, and the cost of being wrong here is interrupting someone. */
export const ENDPOINT_FALLING_MS = 900;
/** Words gave no verdict and the voice is still climbing — a list, a clause
 *  boundary, someone gathering the next thought. Between the moderate wait and
 *  the full thinking window. */
export const ENDPOINT_RISING_MS = 2600;
/** The sentence reads as finished but the voice has not landed. Common when a
 *  recognizer drops a final "…and?" or the speaker adds a trailing qualifier.
 *  A grace period, not a full hold. */
export const ENDPOINT_COMPLETE_RISING_MS = 1200;

/** A turn cannot be held open forever by someone who keeps trailing off. Past
 *  this much total speech the next pause ends it regardless. */
export const MAX_TURN_MS = 45_000;
/** …and past this many consecutive holds, likewise. Guards the case where every
 *  fragment ends on a filler and the turn would otherwise never close. */
export const MAX_CONSECUTIVE_HOLDS = 4;

// ── Vocabulary ──────────────────────────────────────────────────────────────
/** Hesitation sounds. A turn ending on one of these is someone still thinking —
 *  the single strongest "not finished" signal there is. */
const FILLERS = new Set([
  "uh", "uhh", "uhhh", "um", "umm", "ummm", "erm", "er", "err", "ah", "ahh",
  "hmm", "hm", "hmmm", "mm", "mmm", "eh", "uhm", "mhm",
  // Discourse markers that trail off mid-thought in speech.
  "like", "so", "well", "okay", "ok", "right", "actually", "basically",
  "literally", "anyway", "anyways",
  // Hindi hesitation / discourse.
  "मतलब", "यानी", "वो", "अच्छा",
]);

/**
 * Words that cannot end an English sentence. Ending on one of these is a
 * grammatical guarantee that more is coming — the user is mid-clause.
 */
const DANGLING = new Set([
  // Coordinating / subordinating conjunctions
  "and", "or", "but", "nor", "yet", "because", "since", "although", "though",
  "while", "whereas", "unless", "until", "if", "whether", "that", "than", "as",
  // Prepositions
  "of", "to", "in", "on", "at", "for", "with", "from", "by", "about", "into",
  "onto", "over", "under", "between", "among", "through", "during", "before",
  "after", "against", "toward", "towards", "upon", "within", "without", "via",
  // Articles and determiners
  "a", "an", "the", "my", "your", "his", "her", "its", "our", "their", "this",
  "these", "those", "some", "any", "every", "each", "both", "either", "neither",
  // Auxiliaries and modals
  "is", "are", "was", "were", "am", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "can", "could", "will", "would", "shall", "should",
  "may", "might", "must", "ought",
  // Bare subject pronouns — "…and then I" is mid-clause
  "i", "you", "he", "she", "it", "we", "they",
  // Interrogatives being set up
  "what", "which", "who", "whom", "whose", "how", "why", "where", "when",
  // Common verb heads left hanging
  "want", "need", "like", "tell", "give", "show", "make", "let", "know",
  "think", "say", "get", "go", "put", "take",
  // Hindi function words that cannot end an utterance: conjunctions,
  // postpositions, determiners. NOTE the copulas (है/हैं/था/थे/थी) are
  // deliberately absent — Hindi is verb-final, so unlike their English
  // counterparts they are how a sentence normally *ends*. They are listed in
  // HINDI_TERMINAL below instead.
  "और", "या", "लेकिन", "क्योंकि", "अगर", "जब", "तो", "में", "से", "का", "की",
  "के", "को", "पर", "कि", "एक", "मुझे", "आप", "बहुत", "कुछ",
]);

/** Hindi sentence-final verbs and copulas. In an SOV language these landing at
 *  the end is the strongest available signal that the clause is closed. */
const HINDI_TERMINAL = new Set([
  "है", "हैं", "था", "थे", "थी", "थीं", "हूँ", "हूं", "हो", "होगा", "होगी",
  "करो", "बताओ", "दो", "चाहिए", "सकता", "सकते", "सकती",
]);

/** Terminal punctuation across the scripts the app supports. */
const TERMINAL_RE = /[.!?…。！？؟।॥]\s*$/;

/** Short phrases that are complete turns on their own, despite being tiny. */
const COMPLETE_SHORT = new Set([
  "yes", "yeah", "yep", "no", "nope", "stop", "wait", "thanks", "thank you",
  "hello", "hi", "hey", "bye", "goodbye", "sure", "okay", "correct", "exactly",
  "continue", "go on", "repeat that", "never mind",
  "हाँ", "हां", "नहीं", "रुको", "बस", "धन्यवाद", "नमस्ते",
]);

export type Completeness = "complete" | "continuing" | "unclear";

export interface EndpointDecision {
  /** How long to keep listening before treating the turn as over. */
  waitMs: number;
  completeness: Completeness;
  /** Why, for debug logs — the reasoning is invisible otherwise. */
  reason: string;
}

/**
 * Lowercased words, punctuation stripped.
 *
 * `\p{M}` is not optional here. Devanagari vowel signs are combining marks, not
 * letters, so a `\p{L}`-only filter silently shreds every Hindi word — "मुझे"
 * becomes "मझ" — and every rule below then fails to match anything.
 */
const WORD_STRIP_RE = /[^\p{L}\p{M}\p{N}'\s]/gu;

export function words(text: string): string[] {
  return (text || "")
    .toLocaleLowerCase()
    .replace(WORD_STRIP_RE, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when the transcript is nothing but hesitation — "um", "uh so". */
export function isOnlyFiller(text: string): boolean {
  const w = words(text);
  return w.length > 0 && w.every((word) => FILLERS.has(word));
}

/**
 * Collapse stutters and immediate repeats: "the the the report" → "the report",
 * "I I want" → "I want". Speech recognizers transcribe these literally, and
 * they read as noise in the final transcript.
 *
 * Only immediate repeats are touched. Legitimate doubles exist ("that that he
 * said"), but they are rare next to stutters, and the cost of collapsing one is
 * a slightly odd sentence rather than a wrong one.
 */
export function collapseStutters(text: string): string {
  if (!text) return text;
  const tokens = text.split(/(\s+)/); // keep whitespace so spacing survives
  const out: string[] = [];
  let lastWord = "";
  for (const token of tokens) {
    if (!token.trim()) {
      out.push(token);
      continue;
    }
    const normalized = token.toLocaleLowerCase().replace(WORD_STRIP_RE, "");
    if (normalized && normalized === lastWord) {
      // Drop this repeat, and the whitespace we just pushed for it.
      if (out.length && !out[out.length - 1]?.trim()) out.pop();
      continue;
    }
    lastWord = normalized;
    out.push(token);
  }
  return out.join("").replace(/\s{2,}/g, " ").trim();
}

/**
 * Hesitations to strip from a finished transcript. Wider than the `FILLERS` set
 * above, which decides whether someone is *still talking* — a trailing "so" is
 * a strong continuation signal, but a "so" in the middle of a sentence is often
 * meaningful ("so I asked her") and must survive. These are the ones that carry
 * no meaning anywhere: pure hesitation sounds, plus the stock verbal tics.
 */
// The leading `[,;]?\s*` matters: recognizers bracket fillers with commas
// ("what, uh, is the capital"), and removing only the filler and its trailing
// comma strips one side of the pair — leaving "what, is the capital".
const FILLER_RE =
  /[,;]?\s*\b(?:uh+|um+|umm+|umh+|uhm+|err+|er+|erm+|ah+|aah+|hmm+|hm+|mhm+|mm+|you know|i mean|sort of|kind of|मतलब|यानी)\b[,.\s]*/gi;

/**
 * Turn what was said into what was meant.
 *
 * Recognizers transcribe speech literally, disfluencies included: "um, so I
 * I want to know about, uh, Tesla". That is faithful, and it is also worse
 * input for a model than the sentence the speaker intended — the fillers add
 * nothing and the stutters read as emphasis.
 *
 * Order matters. Stutters are collapsed *after* fillers are removed, because
 * removing a filler can push two copies of a word together:
 * "the um the report" → "the  the report" → "the report".
 */
export function cleanTranscript(text: string): string {
  if (!text) return "";
  return collapseStutters(
    text
      .replace(FILLER_RE, " ")
      .replace(/\s+([,.!?])/g, "$1")
      // A filler removed mid-sentence leaves its punctuation behind:
      // "so, um, the report" would otherwise become ", , the report".
      .replace(/(^|\s)[,;]+(?=\s|$)/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim(),
  );
}

/** The transcript-only half of the decision. Wrapped by `judgeEndpoint`. */
function judgeText(transcript: string): EndpointDecision {
  const text = (transcript || "").trim();
  const w = words(text);

  if (w.length === 0) {
    return { waitMs: ENDPOINT_UNCLEAR_MS, completeness: "unclear", reason: "empty" };
  }

  // Nothing but hesitation: the user has not started saying anything yet.
  if (isOnlyFiller(text)) {
    return { waitMs: ENDPOINT_CONTINUING_MS, completeness: "continuing", reason: "filler only" };
  }

  const last = w[w.length - 1] ?? "";

  // A trailing hesitation sound is the clearest "still thinking" there is, and
  // it outranks punctuation — recognizers happily emit "So, um." mid-sentence.
  if (FILLERS.has(last)) {
    return {
      waitMs: ENDPOINT_CONTINUING_MS,
      completeness: "continuing",
      reason: `trailing filler "${last}"`,
    };
  }

  // Grammatically impossible endings. Checked before punctuation for the same
  // reason: "I want to know about the." is a recognizer artifact, not a finished
  // sentence, and cutting the user off there is the exact failure being fixed.
  if (DANGLING.has(last)) {
    return {
      waitMs: ENDPOINT_CONTINUING_MS,
      completeness: "continuing",
      reason: `dangling "${last}"`,
    };
  }

  // Explicit terminal punctuation from a recognizer that emits it.
  if (TERMINAL_RE.test(text)) {
    return { waitMs: ENDPOINT_COMPLETE_MS, completeness: "complete", reason: "terminal punctuation" };
  }

  // A sentence-final Hindi verb closes the clause the way punctuation would.
  if (HINDI_TERMINAL.has(last) && w.length >= 3) {
    return { waitMs: ENDPOINT_COMPLETE_MS, completeness: "complete", reason: `sentence-final "${last}"` };
  }

  // Short affirmations and commands that genuinely stand alone.
  const normalized = w.join(" ");
  if (COMPLETE_SHORT.has(normalized)) {
    return { waitMs: ENDPOINT_COMPLETE_MS, completeness: "complete", reason: "complete short phrase" };
  }

  // One or two words with no other signal: far more often the start of a
  // sentence than the whole of one. Give the user room to continue.
  if (w.length <= 2) {
    return { waitMs: ENDPOINT_CONTINUING_MS, completeness: "continuing", reason: "too short to be a turn" };
  }

  // A recognisable question with a real clause behind it reads as finished even
  // without a question mark: "what is the capital of france".
  const opensQuestion = ["what", "which", "who", "how", "why", "where", "when", "is", "are", "can", "could", "do", "does", "did", "should", "would", "will"]
    .includes(w[0] ?? "");
  if (opensQuestion && w.length >= 5) {
    return { waitMs: ENDPOINT_COMPLETE_MS, completeness: "complete", reason: "complete question" };
  }

  // A substantial statement that ends on a content word. Probably finished, but
  // without punctuation we cannot be sure enough to use the snappy wait.
  return { waitMs: ENDPOINT_UNCLEAR_MS, completeness: "unclear", reason: "no strong signal" };
}

/**
 * Let intonation break the ties the words could not.
 *
 * The asymmetry here is the whole design, so it is worth stating plainly: a
 * pitch contour measured by a hand-rolled autocorrelator is *weaker* evidence
 * than a grammatical rule, and it is treated as such.
 *
 *   - `continuing` is never shortened. "…the capital of" cannot be the end of a
 *     sentence no matter what the speaker's voice did, and a falling contour
 *     there is far more likely to be a tracker error than a finished thought.
 *     Overruling it would reintroduce the exact mid-sentence cut-off this whole
 *     module exists to prevent.
 *   - `complete` is never shortened either — 700 ms is already tight — but a
 *     voice still on the way up earns a grace period, since the sentence
 *     looking finished and the speaker being finished are different claims.
 *   - `unclear` is where prosody is allowed to actually decide, in both
 *     directions. It is the bucket with no competing evidence to defer to, and
 *     the one most turns fall into.
 */
export function applyProsody(base: EndpointDecision, contour: ProsodyContour): EndpointDecision {
  if (contour === "unknown" || contour === "level") return base;

  if (base.completeness === "continuing") return base;

  if (base.completeness === "complete") {
    if (contour !== "rising") return base;
    return {
      waitMs: Math.max(base.waitMs, ENDPOINT_COMPLETE_RISING_MS),
      completeness: "complete",
      reason: `${base.reason} + rising pitch`,
    };
  }

  // unclear: the contour is the only real evidence available, so it decides.
  if (contour === "falling") {
    return {
      waitMs: ENDPOINT_FALLING_MS,
      completeness: "complete",
      reason: `${base.reason} + falling pitch`,
    };
  }
  return {
    waitMs: ENDPOINT_RISING_MS,
    completeness: "continuing",
    reason: `${base.reason} + rising pitch`,
  };
}

/**
 * How long to keep listening after this transcript, given the speaker has just
 * fallen silent.
 *
 * `contour` defaults to `unknown`, which is exactly the text-only behaviour —
 * so a caller with no audio analysis available, or a frame too short to yield a
 * pitch, loses nothing.
 */
export function judgeEndpoint(
  transcript: string,
  contour: ProsodyContour = "unknown",
): EndpointDecision {
  // No transcript at all is not the same as an ambiguous one, and prosody must
  // not be allowed to rule on it.
  //
  // `unclear` means "there are words, and they point neither way" — a genuine
  // tie, which is what a contour is good for breaking. An empty string means
  // the recognizer produced *nothing*: it is offline, it failed, or the audio
  // has not been transcribed yet. There is no tie there, only an absence, and
  // letting pitch decide turns the endpointer into a pure pitch detector that
  // finalizes every 900 ms on a falling voice and never assembles a turn.
  //
  // That is not hypothetical — it is what happens on this app whenever Chrome's
  // speech service is unreachable, and the whole turn then depends on Whisper,
  // which has not run yet at this point in the flow.
  if (!(transcript || "").trim()) return judgeText(transcript);
  return applyProsody(judgeText(transcript), contour);
}
