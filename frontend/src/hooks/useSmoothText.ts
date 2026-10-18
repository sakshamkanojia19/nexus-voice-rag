import { useEffect, useRef, useState } from "react";
import { nextLength, wasReplaced } from "@/lib/smooth-reveal";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/**
 * The part of `target` to display. While `active`, it trails `target` and
 * catches up at a steady pace (see smooth-reveal.ts); once inactive — the turn
 * finished, failed or was stopped — it is the whole text at once, so a settled
 * message never sits half-revealed.
 */
export function useSmoothText(target: string, active: boolean): string {
  const [shown, setShown] = useState(() => (active ? 0 : target.length));
  const shownRef = useRef(shown);
  const targetRef = useRef(target);
  const frameRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  const reduced = useRef(prefersReducedMotion()).current;
  const pacing = active && !reduced;

  // The text was replaced rather than extended: start over from the new text.
  if (targetRef.current !== target) {
    if (wasReplaced(targetRef.current, target, shownRef.current)) {
      shownRef.current = pacing ? 0 : target.length;
    }
    targetRef.current = target;
  }

  useEffect(() => {
    if (!pacing) {
      shownRef.current = target.length;
      setShown(target.length);
      return;
    }
    if (shownRef.current >= target.length || frameRef.current !== null) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      const text = targetRef.current;
      const next = nextLength(shownRef.current, text, dt);
      shownRef.current = next;
      setShown(next);
      frameRef.current = next < text.length ? requestAnimationFrame(tick) : null;
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [target, pacing]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return pacing ? target.slice(0, Math.min(shown, target.length)) : target;
}
