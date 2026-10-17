import { useState } from "react";
import { FileText, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Source } from "@/lib/api";

/**
 * Citations for a turn. Presented as evidence rather than decoration: a plain
 * label row, then uniform cards carrying the reference number, the title, and
 * where it came from. Long lists stay folded — six cards is already enough to
 * push the answer off screen.
 */

const COLLAPSED_COUNT = 4;

/** "https://www.marvel.com/movies/x" → "marvel.com" */
function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function SourceCard({ source }: { source: Source }) {
  const Icon = source.type === "document" ? FileText : Globe;
  const origin = hostOf(source.url) ?? source.doc_name ?? (source.type === "document" ? "Document" : "Web");
  const cls =
    "group flex items-start gap-2.5 rounded-xl border border-border/60 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card/80";

  const inner = (
    <>
      <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-medium tabular-nums text-muted-foreground">
        {source.n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[12.5px] leading-snug text-foreground/85 transition-colors group-hover:text-foreground">
          {source.label}
        </span>
        <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/70">
          <Icon className="size-3 shrink-0" />
          <span className="truncate">
            {origin}
            {source.page ? ` · p.${source.page}` : ""}
          </span>
        </span>
      </span>
    </>
  );

  return source.url ? (
    <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.snippet || source.label} className={cls}>
      {inner}
    </a>
  ) : (
    <span title={source.snippet || source.label} className={cls}>
      {inner}
    </span>
  );
}

export function Sources({ sources }: { sources: Source[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;

  const hidden = sources.length - COLLAPSED_COUNT;
  const shown = expanded ? sources : sources.slice(0, COLLAPSED_COUNT);

  return (
    <section className="mt-5 font-sans">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        Sources
        <span className="ml-1.5 text-muted-foreground/50">{sources.length}</span>
      </h3>
      <div className={cn("grid gap-2", sources.length > 1 && "sm:grid-cols-2")}>
        {shown.map((s) => (
          <SourceCard key={s.n} source={s} />
        ))}
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show fewer sources" : `Show ${hidden} more source${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </section>
  );
}
