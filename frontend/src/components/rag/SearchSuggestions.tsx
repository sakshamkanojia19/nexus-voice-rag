import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchSuggestionsProps {
  items: string[];
  /** What the user typed — rendered plain so only the completion stands out. */
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (text: string) => void;
}

/** Splits a suggestion into the part the user already typed and the part being
 *  suggested, so only the completion is emphasised. Falls back to bolding the
 *  whole row when the suggestion isn't a straight continuation. */
function splitCompletion(text: string, query: string): [string, string] {
  const q = query.trim();
  return text.toLowerCase().startsWith(q.toLowerCase())
    ? [text.slice(0, q.length), text.slice(q.length)]
    : ["", text];
}

export function SearchSuggestions({ items, query, activeIndex, onHover, onPick }: SearchSuggestionsProps) {
  if (items.length === 0) return null;

  return (
    // Negative margins cancel the composer's padding so a highlighted row spans
    // the full card and the list sits flush with its bottom edge.
    <ul
      role="listbox"
      aria-label="Search suggestions"
      className="-mx-4 -mb-4 mt-2 overflow-hidden rounded-b-3xl border-t border-border/60 pt-1 md:-mx-5 md:-mb-5"
    >
      {items.map((text, i) => {
        const [typed, completion] = splitCompletion(text, query);
        return (
          <li key={text}>
            <button
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              // Mouse-down fires before the textarea's blur, so the pick isn't
              // lost to a re-render that closes the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(text);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                // py-3 on touch widths keeps each row at a ~44px tap target.
                "flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors sm:py-2.5 md:px-5",
                i === activeIndex ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Search className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span className="min-w-0 flex-1 truncate">
                {typed}
                <span className="font-semibold text-foreground">{completion}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
