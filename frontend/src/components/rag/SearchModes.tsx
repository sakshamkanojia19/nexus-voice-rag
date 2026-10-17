import { useState } from "react";
import { cn } from "@/lib/utils";
import type { SearchMode } from "@/lib/api";
import { SEARCH_MODES } from "@/lib/searchModes";

interface SearchModesProps {
  value: SearchMode;
  onChange: (mode: SearchMode) => void;
}

/** The Instant / Web / Deep chip group. Exactly one is always active — the mode
 *  decides which tools the agent gets, so "none selected" isn't a valid state. */
export function SearchModes({ value, onChange }: SearchModesProps) {
  // Hover-described rather than always-labelled: three permanent word-chips
  // would crowd out the document and voice controls sharing this row.
  const [hovered, setHovered] = useState<SearchMode | null>(null);
  const described = SEARCH_MODES.find((m) => m.id === hovered);

  return (
    <div className="relative">
      {described ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-56 rounded-xl bg-popover px-3 py-2 shadow-soft ring-1 ring-border animate-fade-in"
        >
          <p className="text-xs font-semibold text-popover-foreground">{described.label}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{described.blurb}</p>
        </div>
      ) : null}

      <div className="flex items-center gap-0.5 rounded-full bg-muted/40 p-0.5">
        {SEARCH_MODES.map((mode) => {
          const Icon = mode.icon;
          const active = value === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => onChange(mode.id)}
              onMouseEnter={() => setHovered(mode.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(mode.id)}
              onBlur={() => setHovered(null)}
              aria-pressed={active}
              aria-label={`${mode.label} — ${mode.blurb}`}
              className={cn(
                "flex size-7 items-center justify-center rounded-full transition-all",
                active
                  ? mode.activeClass
                  : "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className={cn("size-3.5", active && "text-primary")} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
