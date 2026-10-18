/**
 * Markdown that is still arriving.
 *
 * Two problems make a streamed answer jump around, and both are about the text
 * rather than about React:
 *
 *   1. Re-parsing the whole answer on every token costs O(n) per token, and
 *      every paragraph, table and citation chip on screen is rebuilt with it.
 *      `splitBlocks` cuts the text into top-level blocks so finished ones can be
 *      memoized and only the last one is re-rendered.
 *   2. Half-written syntax renders as raw text and then snaps into formatting:
 *      `**bo` shows its asterisks, `[1` shows a bracket that later becomes a
 *      chip, a table header is a line of pipes until its `|---|` row arrives,
 *      and `text\n-` is briefly a heading. `stabilizeTail` holds those back (or
 *      closes them) so what is on screen only ever grows.
 *
 * Both are pure so they can be tested without a DOM.
 */

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Reference-style links and footnotes resolve across the whole document, so
 * splitting would orphan them. Rare in model output; render whole when present.
 */
export function canSplit(text: string): boolean {
  return !/\[\^[^\]]*\]|^\s{0,3}\[[^\]]+\]:\s/m.test(text);
}

/**
 * Top-level blocks, split on blank lines — but never inside a code fence, never
 * before an indented continuation (a split there would turn it into a code
 * block), and never between two list items (a split there would turn one list
 * into several). Joining the blocks with "\n\n" reproduces the input's content.
 */
export function splitBlocks(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  let sawBlank = false;

  const firstLine = (b: string[]) => b.find((l) => l.trim() !== "") ?? "";

  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const blank = !inFence && line.trim() === "";
    if (blank) {
      if (current.length > 0) sawBlank = true;
      continue;
    }
    if (sawBlank && current.length > 0) {
      const continues =
        /^\s/.test(line) || (LIST_ITEM_RE.test(line) && LIST_ITEM_RE.test(firstLine(current)));
      if (continues) {
        current.push("");
      } else {
        blocks.push(current);
        current = [];
      }
      sawBlank = false;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks.map((b) => b.join("\n"));
}

/** Count of `**` outside inline code spans. */
function countStrong(text: string): number {
  return (text.replace(/`[^`\n]*`/g, "").match(/\*\*/g) ?? []).length;
}

/**
 * The last block, made safe to render mid-stream. Only ever removes or closes
 * syntax at the very end — it never rewrites what the user has already read.
 */
export function stabilizeTail(tail: string): string {
  let text = tail;

  // An open code fence: close it so the code renders as code, not as prose.
  const fenceLines = text.split("\n").filter((l) => FENCE_RE.test(l));
  if (fenceLines.length % 2 === 1) {
    const opener = FENCE_RE.exec(fenceLines[fenceLines.length - 1] ?? "")?.[1] ?? "```";
    return `${text.trimEnd()}\n${opener}`;
  }

  // Tables: nothing until the delimiter row exists, then only whole rows.
  const lines = text.split("\n");
  const tableStart = lines.findIndex((l) => l.trim().startsWith("|"));
  if (tableStart !== -1 && lines.slice(tableStart).every((l) => l.trim().startsWith("|"))) {
    const table = lines.slice(tableStart);
    const before = lines.slice(0, tableStart);
    if (table.length < 2 || !TABLE_DELIMITER_RE.test(table[1] ?? "")) {
      text = before.join("\n");
    } else {
      // A row is whole once it has as many cells as the header and is closed.
      // Ending on a pipe alone is not enough: "| Engagement envelope |" is
      // the first cell of a two-cell row, and showing it would un-show it a
      // token later when the second cell starts.
      const pipes = (line: string) => (line.match(/(?<!\\)\|/g) ?? []).length;
      const last = table[table.length - 1] ?? "";
      if (table.length > 2 && (!/\|\s*$/.test(last) || pipes(last) < pipes(table[0] ?? ""))) table.pop();
      text = [...before, ...table].join("\n");
    }
  }

  // A last line that is only a block marker so far: "-", "1.", "#", ">", or a
  // run of "-"/"=" that would turn the paragraph above it into a heading.
  text = text.replace(/(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>|[-=]+)[ \t]*$/, "");

  // A citation or link still being written: "[1", "[see", "[text](htt".
  text = text.replace(/\[[^\]\n]*\]\([^)\n]*$/, "").replace(/\[[^\]\n]*$/, "");

  // Unclosed bold. An opener with nothing after it yet is dropped; one with
  // words after it is closed so they render bold now rather than after a snap.
  if (countStrong(text) % 2 === 1) {
    const at = text.lastIndexOf("**");
    text = text.slice(at + 2).trim() === "" ? text.slice(0, at) : `${text.trimEnd()}**`;
  } else if (/(^|\s)\*$/.test(text)) {
    // A lone "*" after a space is the start of emphasis ("**" half-sent). One
    // after a word closes italics and must stay.
    text = text.slice(0, -1);
  }

  // Unclosed inline code.
  const ticks = (text.replace(/```/g, "").match(/`/g) ?? []).length;
  if (ticks % 2 === 1) text = `${text}\``;

  return text.trimEnd();
}
