/**
 * Telling Whisper what it is about to hear.
 *
 * Whisper decodes acoustically ambiguous audio by picking the likeliest words,
 * and "likeliest" means likeliest in general English — where "drag" is far more
 * common than "RAG". So a user asking this app about RAG gets asked back about
 * drag culture, which is the failure this exists to fix. The model is not
 * mishearing so much as guessing, and `initial_prompt` is how you tell it what
 * to guess toward: text supplied as though it preceded the audio, biasing the
 * decoder's vocabulary without constraining it.
 *
 * Two rules shape everything below.
 *
 * First, a prompt is a bias, not a filter. Every term added makes that term
 * cheaper to output *everywhere*, including in audio that did not contain it —
 * so the list stays short and stays limited to words this app actually causes
 * people to say. Padding it with plausible jargon would trade "drag" for a
 * different wrong word.
 *
 * Second, Whisper will happily transcribe the prompt back at you when the audio
 * is silence or noise. That is a known failure mode and it is why the prompt is
 * kept terse, and why the backend filters segments that merely echo it.
 */

/**
 * Terms this app makes people say, which general English models get wrong.
 *
 * Every entry earns its place by being both (a) something a user of *this* app
 * says out loud and (b) something that decodes to a commoner word without help.
 * "RAG" is the motivating case; the rest follow the same test.
 */
const DOMAIN_TERMS = [
  "RAG",
  "LLM",
  "Nexus",
  "Qdrant",
  "embeddings",
  "vector database",
  "API key",
];

/** Hard ceiling on prompt length. Whisper truncates its conditioning text at
 *  224 tokens, and a prompt near that limit is both wasteful and more likely to
 *  be echoed back on silence. Characters are a coarse proxy, deliberately
 *  conservative. */
export const WHISPER_PROMPT_MAX_CHARS = 400;

/** Document titles are the strongest available signal, so they get the most
 *  room — but not unbounded room, or one long filename crowds out the rest. */
const MAX_DOC_NAMES = 6;

/** Strip the extension and separators so "Q3_earnings-report.pdf" reads as the
 *  words a speaker would actually say. */
function titleFromFilename(name: string): string {
  return (name || "")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Build the `initial_prompt` for a voice turn.
 *
 * `docNames` are the documents currently selected for grounding. They matter
 * more than the fixed vocabulary: someone who has just uploaded a report is
 * about to say its title and the proper nouns inside it, and those are exactly
 * the words with no chance of being decoded correctly unprompted.
 */
export function buildWhisperPrompt(docNames: readonly string[] = []): string {
  const titles = docNames
    .map(titleFromFilename)
    .filter(Boolean)
    .slice(0, MAX_DOC_NAMES);

  // Phrased as a sentence rather than a bare word list: the prompt is treated
  // as preceding *speech*, so prose conditions the decoder toward transcribing
  // a spoken sentence, where a list conditions it toward emitting a list.
  const parts = [`A spoken question for Nexus about ${DOMAIN_TERMS.join(", ")}.`];
  if (titles.length) parts.push(`Documents: ${titles.join(", ")}.`);

  const prompt = parts.join(" ");
  return prompt.length <= WHISPER_PROMPT_MAX_CHARS
    ? prompt
    : `${prompt.slice(0, WHISPER_PROMPT_MAX_CHARS - 1).trimEnd()}.`;
}

/**
 * Whisper has a known failure mode where it echoes the `prompt` parameter
 * back as the transcript when the audio is silent / too noisy / too short.
 * Detect by checking if the transcript is dominated by tokens from the prompt.
 */
export function isPromptEcho(transcript: string, prompt: string): boolean {
  const p = prompt.trim();
  if (!p) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const t = norm(transcript);
  const np = norm(p);
  if (!t) return true;
  // Exact / substring match — clear echo.
  if (t === np || np.includes(t) || t.includes(np)) return true;
  const tTokens = t.split(" ").filter(Boolean);
  if (tTokens.length === 0) return true;
  if (tTokens.length > 20) return false;
  const pTokenSet = new Set(np.split(" ").filter(Boolean));
  // Token-overlap heuristic: if >=70% of the transcript's tokens come from the
  // prompt and the transcript is short-ish, it's probably an echo.
  const overlap = tTokens.filter((tok) => pTokenSet.has(tok)).length;
  if (overlap / tTokens.length >= 0.7) return true;
  // A degenerate echo loops on the prompt's terms. "LLM, Nexus, Qdrant,
  // embeddings, Qdrant, and Qdrant, embeddings, Qdrant, and Qdrant, are you?"
  // scored 9/13 = 0.69 on overlap and was submitted as a question. A real
  // question almost never says the same prompt word three times.
  const counts = new Map<string, number>();
  for (const tok of tTokens) {
    if (tok.length > 2 && pTokenSet.has(tok)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n >= PROMPT_TERM_REPEATS);
}

/** Repeats of one prompt word, in a short transcript, that mark it as an echo. */
const PROMPT_TERM_REPEATS = 3;
