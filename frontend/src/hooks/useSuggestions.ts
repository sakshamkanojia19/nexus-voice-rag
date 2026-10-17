import { useEffect, useState } from "react";
import { fetchSuggestions } from "@/lib/api";

/** Below this, suggestions are mostly noise and every keystroke is a request. */
const MIN_CHARS = 2;
/** Typing pause before we ask. Short enough to feel live, long enough that a
 *  normal typing burst costs one request instead of one per character. */
const DEBOUNCE_MS = 160;

/**
 * Autocomplete candidates for the current query.
 *
 * Each render's request is aborted when the query changes, so a slow reply for
 * an earlier prefix can never overwrite a newer one — the usual autocomplete
 * race, where suggestions flicker back to what you typed two keystrokes ago.
 */
export function useSuggestions(query: string, enabled: boolean, lang?: string): string[] {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < MIN_CHARS) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchSuggestions(q, lang, controller.signal)
        .then(setItems)
        .catch(() => {/* aborted or upstream down — keep the last list */});
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, lang]);

  return items;
}
