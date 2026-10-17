import { Beaker, Globe, Zap } from "lucide-react";
import type { SearchMode } from "./api";

export interface SearchModeDef {
  id: SearchMode;
  label: string;
  blurb: string;
  icon: typeof Zap;
  /** Tailwind classes for the chip when this mode is the active one. */
  activeClass: string;
}

/** One selected treatment for all three, so the group reads as a segmented
 *  control rather than three competing brand colours. Which mode is active is
 *  carried by the raised surface and the icon tint — not by hue-coding. */
const ACTIVE_CHIP = "bg-background text-foreground shadow-sm ring-1 ring-border";

/** The three composer chips, in display order. `web` is the default because
 *  it's the only one that both grounds answers and stays quick. */
export const SEARCH_MODES: SearchModeDef[] = [
  {
    id: "instant",
    label: "Instant Search",
    blurb: "Lightning-fast answers for quick general queries",
    icon: Zap,
    activeClass: ACTIVE_CHIP,
  },
  {
    id: "web",
    label: "Web Search",
    blurb: "Deep web search with source verification",
    icon: Globe,
    activeClass: ACTIVE_CHIP,
  },
  {
    id: "deep",
    label: "Deep Research",
    blurb: "Multi-step research across documents and the web",
    icon: Beaker,
    activeClass: ACTIVE_CHIP,
  },
];

export const DEFAULT_SEARCH_MODE: SearchMode = "web";

const STORAGE_KEY = "nexus_search_mode";

export function loadSearchMode(): SearchMode {
  if (typeof window === "undefined") return DEFAULT_SEARCH_MODE;
  const saved = localStorage.getItem(STORAGE_KEY);
  return SEARCH_MODES.some((m) => m.id === saved) ? (saved as SearchMode) : DEFAULT_SEARCH_MODE;
}

export function saveSearchMode(mode: SearchMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {/* private mode / quota — the default is fine */}
}
