/**
 * Chunking rules for streamed text-to-speech.
 *
 * A reply is normally spoken one whole sentence at a time, which sounds best.
 * The exception is the very first chunk: waiting for the opening sentence's
 * terminator is silence the user hears as lag, so we cut the opening clause and
 * start talking while the rest of the reply is still streaming in.
 */

// Too small and the first chunk sounds clipped ("Sure,"); too large and we're
// back to waiting for the sentence that caused the lag in the first place. At a
// typical streaming rate of ~160 chars/s, the 90-char ceiling caps the wait for
// a boundary-free opening at roughly half a second.
export const OPENER_MIN_CHARS = 20;
export const OPENER_MAX_CHARS = 90;

const CLAUSE_BOUNDARY = /[,;:—–]/g;

/**
 * The largest natural-sounding prefix of an unfinished sentence, or "" if it's
 * still too short to be worth speaking. Prefers a clause boundary (comma,
 * semicolon, dash); falls back to a word boundary once the buffer gets long.
 *
 * The returned string is a literal prefix of `text`, so its `.length` is a
 * valid amount to advance the stream position by.
 */
export function openingClause(text: string): string {
  if (text.length < OPENER_MIN_CHARS) return "";

  let cut = -1;
  CLAUSE_BOUNDARY.lastIndex = 0;
  for (let m = CLAUSE_BOUNDARY.exec(text); m; m = CLAUSE_BOUNDARY.exec(text)) {
    // Keep the boundary character itself so TTS phrases it correctly.
    const end = m.index + 1;
    if (end >= OPENER_MIN_CHARS && end <= OPENER_MAX_CHARS) cut = end;
  }
  if (cut > 0) return text.slice(0, cut);

  if (text.length >= OPENER_MAX_CHARS) {
    const space = text.lastIndexOf(" ", OPENER_MAX_CHARS);
    if (space >= OPENER_MIN_CHARS) return text.slice(0, space);
  }
  return "";
}
