// Exercises the real src/lib/whisper-prompt.ts.
//
// The prompt is a bias, not a filter, so the properties worth pinning are about
// restraint: it must stay short, must not grow without bound as documents are
// added, and must survive filenames that are not tidy.
import { WHISPER_PROMPT_MAX_CHARS, buildWhisperPrompt } from "./whisper-prompt.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

// ── The motivating case ────────────────────────────────────────────────────
check("the prompt names RAG, the term that decodes to 'drag' unprompted", buildWhisperPrompt().includes("RAG"));
check("the prompt works with no documents at all", buildWhisperPrompt().length > 0);
check("…and with an explicitly empty list", buildWhisperPrompt([]) === buildWhisperPrompt());

// ── Documents ──────────────────────────────────────────────────────────────
{
  const p = buildWhisperPrompt(["Q3_earnings-report.pdf"]);
  check("a document title reaches the prompt", p.includes("Q3 earnings report"), p);
  check("…without its file extension", !p.includes(".pdf"), p);
  check("…with separators turned back into spaces", !p.includes("_") && !p.includes("-"), p);
}
check(
  "a title that is only an extension does not leave an empty entry",
  !buildWhisperPrompt([".pdf", "real.pdf"]).includes(", ,"),
  buildWhisperPrompt([".pdf", "real.pdf"]),
);
check("blank names are dropped", !buildWhisperPrompt(["", "   "]).includes("Documents:"));

// ── Restraint ──────────────────────────────────────────────────────────────
// Whisper truncates conditioning text, and a long prompt is likelier to be
// echoed back on silence. Neither many documents nor one absurd filename may
// push it past the cap.
{
  const many = Array.from({ length: 50 }, (_, i) => `report number ${i}.pdf`);
  check(
    "50 documents stay within the cap",
    buildWhisperPrompt(many).length <= WHISPER_PROMPT_MAX_CHARS,
    `${buildWhisperPrompt(many).length} chars`,
  );
  const huge = [`${"x".repeat(5000)}.pdf`];
  check(
    "one absurd filename stays within the cap",
    buildWhisperPrompt(huge).length <= WHISPER_PROMPT_MAX_CHARS,
    `${buildWhisperPrompt(huge).length} chars`,
  );
}
check(
  "the prompt is short enough not to dominate a decode",
  buildWhisperPrompt().length < 200,
  `${buildWhisperPrompt().length} chars`,
);

// ── Stability ──────────────────────────────────────────────────────────────
// It is memoised on the document set upstream, so equal input must give an
// identical string or the memo thrashes.
check(
  "the same documents give the same prompt",
  buildWhisperPrompt(["a.pdf", "b.pdf"]) === buildWhisperPrompt(["a.pdf", "b.pdf"]),
);
check(
  "different documents give different prompts",
  buildWhisperPrompt(["a.pdf"]) !== buildWhisperPrompt(["b.pdf"]),
);

console.log(failed === 0 ? "\nAll whisper-prompt checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
