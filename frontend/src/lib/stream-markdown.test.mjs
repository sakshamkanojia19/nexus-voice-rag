// Exercises the real src/lib/stream-markdown.ts.
//
// The property that matters: what is on screen mid-stream only ever grows into
// its final form — no raw syntax that later snaps into formatting, and no split
// that changes how the finished answer renders.
import { canSplit, splitBlocks, stabilizeTail } from "./stream-markdown.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const same = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

// ── splitBlocks ────────────────────────────────────────────────────────────
same("paragraphs split on blank lines", splitBlocks("one\n\ntwo\n\n\nthree"), ["one", "two", "three"]);
same("empty text has no blocks", splitBlocks(""), []);
same(
  "a code fence with blank lines inside stays one block",
  splitBlocks("intro\n\n```py\na = 1\n\nb = 2\n```\n\nafter"),
  ["intro", "```py\na = 1\n\nb = 2\n```", "after"],
);
same(
  "a loose list stays one list",
  splitBlocks("1. first\n\n2. second\n\n3. third"),
  ["1. first\n\n2. second\n\n3. third"],
);
same(
  "an indented continuation is not split into a code block",
  splitBlocks("- item\n\n    more of the item\n\nnext para"),
  ["- item\n\n    more of the item", "next para"],
);
same(
  "a heading, a table and a paragraph are separate blocks",
  splitBlocks("## Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone."),
  ["## Title", "| a | b |\n|---|---|\n| 1 | 2 |", "Done."],
);
check("footnotes and reference links render whole", !canSplit("see [^1]\n\n[^1]: note") && !canSplit("[a]: http://x"));
check("ordinary text splits", canSplit("a [1] b\n\nc [2]"));

// ── stabilizeTail: holds back half-written syntax ──────────────────────────
eq("a citation still being written is held back", stabilizeTail("Pizza is from Naples [1"), "Pizza is from Naples");
eq("an open bracket alone is held back", stabilizeTail("Pizza is [") , "Pizza is");
eq("a complete citation is kept", stabilizeTail("Pizza is from Naples [1]"), "Pizza is from Naples [1]");
eq("a half-written link is held back", stabilizeTail("See [the docs](https://exa"), "See");
eq("bold with words after it is closed", stabilizeTail("This is **very imp"), "This is **very imp**");
eq("a bare bold opener is dropped", stabilizeTail("This is **"), "This is");
eq("closed bold is untouched", stabilizeTail("This is **bold** text"), "This is **bold** text");
eq("a lone star after a space is held back", stabilizeTail("This is *"), "This is");
eq("a closing italic star stays", stabilizeTail("This is *italic*"), "This is *italic*");
eq("inline code is closed", stabilizeTail("run `npm in"), "run `npm in`");
eq("an open fence is closed", stabilizeTail("```py\nprint(1)"), "```py\nprint(1)\n```");
eq("a lone list marker is held back", stabilizeTail("Steps:\n-"), "Steps:");
eq("a lone number marker is held back", stabilizeTail("Steps:\n1."), "Steps:");
eq("a setext underline is not a heading yet", stabilizeTail("Some text\n-"), "Some text");
eq("a lone heading marker is held back", stabilizeTail("#"), "");
eq("a year at the end of a sentence survives", stabilizeTail("It launched in 2026."), "It launched in 2026.");
eq("C# survives", stabilizeTail("Written in C#"), "Written in C#");
eq("a table header waits for its delimiter row", stabilizeTail("| Feature | Details |"), "");
eq(
  "text before a pending table still shows",
  stabilizeTail("Key points:\n| Feature | Details |"),
  "Key points:",
);
eq(
  "a table shows once the delimiter arrives",
  stabilizeTail("| a | b |\n|---|---|"),
  "| a | b |\n|---|---|",
);
eq(
  "a half-written row is held back",
  stabilizeTail("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | fo"),
  "| a | b |\n|---|---|\n| 1 | 2 |",
);
eq(
  "a row closed after its first cell is still half-written",
  stabilizeTail("| a | b |\n|---|---|\n| 1 | 2 |\n| Engagement envelope |"),
  "| a | b |\n|---|---|\n| 1 | 2 |",
);
eq(
  "a whole last row shows",
  stabilizeTail("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"),
  "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
);
eq("finished prose is untouched", stabilizeTail("Pizza is a flat dough base."), "Pizza is a flat dough base.");

console.log(failed ? `\n${failed} check(s) failed` : "\nall stream-markdown checks passed");
if (failed) process.exit(1);
