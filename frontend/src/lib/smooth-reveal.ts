/**
 * Paced reveal for streamed text.
 *
 * Groq delivers tokens in bursts — nothing for 80 ms, then 300 characters in one
 * network read. Rendering each burst as it lands is what reads as text
 * "jumping in". Instead the display drains the backlog over a short window:
 * fast enough that it never trails the network by more than ~`LAG_MS`, slow
 * enough that a burst becomes a sweep rather than a jump.
 *
 * Display only. Speech reads the raw accumulator, so pacing never delays audio.
 */

/** The display aims to be caught up within this long of any burst. */
export const LAG_MS = 150;
/** Minimum reveal speed, so a short backlog does not crawl. */
export const MIN_CHARS_PER_SEC = 90;
/** How far past the computed point we will look for a word boundary. */
const WORD_LOOKAHEAD = 16;

/**
 * How much of `target` to show after `dtMs` more milliseconds, given `shown`
 * characters are on screen now. Lands on word boundaries so half-words do not
 * flicker in, except at the very end of what has arrived.
 */
export function nextLength(shown: number, target: string, dtMs: number): number {
  const total = target.length;
  if (shown >= total) return total;
  const dt = Math.max(0, Math.min(dtMs, 100)); // a backgrounded tab returns a huge dt
  const backlog = total - shown;
  const step = Math.max(
    Math.ceil((MIN_CHARS_PER_SEC * dt) / 1000),
    Math.ceil((backlog * dt) / LAG_MS),
  );
  let end = Math.min(total, shown + step);
  if (end >= total) return total;
  const limit = Math.min(total, end + WORD_LOOKAHEAD);
  while (end < limit && !/\s/.test(target[end] ?? "")) end++;
  return end;
}

/**
 * Whether the text being revealed was replaced rather than extended (an error
 * message, a barge-in truncation). Pacing then restarts from the new text.
 */
export function wasReplaced(previous: string, next: string, shown: number): boolean {
  return !next.startsWith(previous.slice(0, Math.min(shown, previous.length)));
}
