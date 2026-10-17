/**
 * Which language a piece of text is written in, judged from its script.
 *
 * Text-to-speech voices are per language, and a voice handed text in a script
 * it can't read doesn't mispronounce it — it skips it. An English voice given
 * a Hindi joke in Devanagari plays nothing at all, which the user hears as the
 * assistant not answering. So before speaking, the text's own script decides
 * which language's voice reads it, not the language picked for the call.
 */

interface ScriptRule {
  re: RegExp;
  /** Languages written in this script; the first is the default reading. */
  langs: string[];
}

// Order matters only for Japanese: kana marks Japanese even when the sentence
// also carries kanji, which would otherwise count as Chinese.
const SCRIPTS: ScriptRule[] = [
  { re: /[぀-ヿ]/g, langs: ["ja"] },
  { re: /[ऀ-ॿ]/g, langs: ["hi", "mr", "ne"] }, // Devanagari
  { re: /[ঀ-৿]/g, langs: ["bn"] },
  { re: /[਀-੿]/g, langs: ["pa"] }, // Gurmukhi
  { re: /[઀-૿]/g, langs: ["gu"] },
  { re: /[஀-௿]/g, langs: ["ta"] },
  { re: /[ఀ-౿]/g, langs: ["te"] },
  { re: /[؀-ۿ]/g, langs: ["ar", "ur", "fa"] }, // Arabic script
  { re: /[가-힯]/g, langs: ["ko"] },
  { re: /[一-鿿]/g, langs: ["zh", "ja"] },
];

const LATIN = /[a-z]/gi;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * The two-letter language of `text`'s dominant non-Latin script, or null when
 * the text is mostly Latin (or empty) and any voice for the call will do.
 *
 * `preferred` is the call's language: where a script is shared (Devanagari for
 * Hindi and Marathi, Arabic script for Arabic and Urdu) and the user picked one
 * of its languages, that one wins.
 */
export function scriptLanguage(text: string, preferred = ""): string | null {
  const latin = count(text, LATIN);
  let best: ScriptRule | null = null;
  let bestCount = 0;
  for (const rule of SCRIPTS) {
    const n = count(text, rule.re);
    if (n > bestCount) {
      best = rule;
      bestCount = n;
    }
    // Kana wins outright once present — see the ordering note above.
    if (rule.langs[0] === "ja" && n > 0) {
      best = rule;
      break;
    }
  }
  if (!best || bestCount === 0 || (best.langs[0] !== "ja" && bestCount <= latin)) return null;
  const want = preferred.toLowerCase().slice(0, 2);
  return best.langs.includes(want) ? want : best.langs[0];
}
