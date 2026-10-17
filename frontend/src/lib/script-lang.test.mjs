// Exercises the real src/lib/script-lang.ts. The failure it guards: a Hindi
// joke in Devanagari handed to an English voice, which plays silence.
import { scriptLanguage } from "./script-lang.ts";

let failed = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `   → got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

// The captured case.
check("a Hindi joke in Devanagari reads as Hindi",
  scriptLanguage("एक बार एक आदमी डॉक्टर के पास गया और बोला, डॉक्टर साहब!"), "hi");
check("English stays with the call's voice", scriptLanguage("Pizza is a baked dish from Italy."), null);
check("empty text has no language", scriptLanguage(""), null);
check("digits and punctuation alone have no language", scriptLanguage("42 — 3.5!"), null);

// Mixed text goes by the dominant script.
check("mostly English with one Hindi word stays English",
  scriptLanguage("In Hindi you say नमस्ते when you greet someone politely."), null);
check("mostly Hindi with an English brand name is Hindi",
  scriptLanguage("Grok एक AI मॉडल है जो xAI ने बनाया है।"), "hi");

// Shared scripts follow the call's language when it is one of them.
check("Devanagari on a Marathi call is Marathi", scriptLanguage("तुम्ही कसे आहात?", "mr-IN"), "mr");
check("Devanagari on an English call defaults to Hindi", scriptLanguage("आप कैसे हैं?", "en-US"), "hi");
check("Arabic script on an Urdu call is Urdu", scriptLanguage("آپ کیسے ہیں؟", "ur-PK"), "ur");
check("Arabic script otherwise is Arabic", scriptLanguage("كيف حالك؟"), "ar");

// Other Indian scripts.
check("Tamil", scriptLanguage("நீங்கள் எப்படி இருக்கிறீர்கள்?"), "ta");
check("Bengali", scriptLanguage("আপনি কেমন আছেন?"), "bn");
check("Telugu", scriptLanguage("మీరు ఎలా ఉన్నారు?"), "te");
check("Gujarati", scriptLanguage("તમે કેમ છો?"), "gu");
check("Punjabi (Gurmukhi)", scriptLanguage("ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?"), "pa");

// East Asian.
check("Japanese with kanji and kana is Japanese", scriptLanguage("今日はいい天気ですね。"), "ja");
check("Chinese", scriptLanguage("今天天气很好。"), "zh");
check("Korean", scriptLanguage("안녕하세요?"), "ko");

console.log(failed ? `\n${failed} check(s) failed` : "\nall script-lang checks passed");
process.exit(failed ? 1 : 0);
