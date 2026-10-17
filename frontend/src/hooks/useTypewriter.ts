import { useEffect, useRef, useState } from "react";

/**
 * Typewriter effect that types out each phrase, pauses, deletes, and moves on —
 * used for the animated placeholder in the hero search bar (CiteTalk-style).
 * Pauses when `paused` is true and shows a static phrase under reduced-motion.
 */
export function useTypewriter(phrases: string[], paused = false): string {
  const [text, setText] = useState("");
  const idx = useRef(0);
  const chars = useRef(0);
  const deleting = useRef(false);

  useEffect(() => {
    if (paused || phrases.length === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setText(phrases[0]);
      return;
    }
    let timeout = 0;
    const tick = () => {
      const phrase = phrases[idx.current % phrases.length];
      if (!deleting.current) {
        chars.current += 1;
        setText(phrase.slice(0, chars.current));
        if (chars.current >= phrase.length) {
          deleting.current = true;
          timeout = window.setTimeout(tick, 1800); // hold the full phrase
          return;
        }
        timeout = window.setTimeout(tick, 55);
      } else {
        chars.current -= 1;
        setText(phrase.slice(0, Math.max(0, chars.current)));
        if (chars.current <= 0) {
          deleting.current = false;
          idx.current += 1;
          timeout = window.setTimeout(tick, 350);
          return;
        }
        timeout = window.setTimeout(tick, 26);
      }
    };
    timeout = window.setTimeout(tick, 500);
    return () => window.clearTimeout(timeout);
  }, [paused, phrases]);

  return text;
}
