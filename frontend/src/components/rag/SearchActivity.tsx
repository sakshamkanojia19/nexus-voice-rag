import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, FileText, Globe, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatTurn, ToolActivity } from "@/hooks/useChat";

/**
 * Retrieval progress for one assistant turn.
 *
 * While the agent works this is a live timeline — one row per query, the
 * running one shimmering, each finished one carrying the time it took. When the
 * turn settles it folds itself into a single quiet line ("Searched the web ·
 * 2 queries · 4.2s") that stays expandable, so the finished answer is what the
 * eye lands on rather than the machinery that produced it.
 *
 * Colour discipline: everything here is neutral grey. The violet accent is
 * spent only on what is *live* (the spinner, the progress sweep) — that is what
 * makes "still working" readable at a glance without the block shouting.
 */

/** Ticking stopwatch for the running step. 10 Hz reads as live without churn. */
function useElapsed(active: boolean, from?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !from) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [active, from]);
  return from ? Math.max(0, now - from) : 0;
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function isDocStep(t: ToolActivity): boolean {
  return t.name === "search_documents";
}

/** Header wording follows the mode, so deep research doesn't read like a lookup. */
function runningLabel(tools: ToolActivity[], mode: ChatTurn["mode"]): string {
  if (tools.length === 0) return mode === "deep" ? "Planning research" : "Thinking";
  const current = tools[tools.length - 1];
  if (mode === "deep") return "Researching";
  return isDocStep(current) ? "Searching your documents" : "Searching the web";
}

function summaryLabel(tools: ToolActivity[], mode: ChatTurn["mode"]): string {
  const docs = tools.filter(isDocStep).length;
  const web = tools.length - docs;
  if (mode === "deep") return "Deep research";
  if (docs && web) return "Searched documents and the web";
  return docs ? "Searched your documents" : "Searched the web";
}

function StepRow({
  tool,
  running,
  duration,
}: {
  tool: ToolActivity;
  running: boolean;
  duration: string | null;
}) {
  const Icon = isDocStep(tool) ? FileText : Globe;
  return (
    <li className="flex items-start gap-2.5 py-[3px]">
      <Icon
        className={cn(
          "mt-[3px] size-3.5 shrink-0",
          running ? "text-foreground/60" : "text-muted-foreground/50",
        )}
      />
      <span className="min-w-0 flex-1 text-[13px] leading-snug">
        <span
          className={cn(
            "break-words",
            running ? "text-shimmer" : "text-muted-foreground",
          )}
        >
          {tool.query || (isDocStep(tool) ? "your documents" : "the web")}
        </span>
      </span>
      <span className="mt-[3px] shrink-0 text-[11px] leading-none tabular-nums text-muted-foreground/50">
        {running ? (
          <Loader2 className="size-3 animate-spin text-primary/70" />
        ) : (
          duration
        )}
      </span>
    </li>
  );
}

export function SearchActivity({ turn }: { turn: ChatTurn }) {
  const tools = turn.tools ?? [];
  const streaming = turn.status === "streaming";
  const hasContent = turn.content.trim().length > 0;
  // Once prose starts arriving the retrieval phase is over, so the last step is
  // only "running" while the turn is still silent.
  const runningIndex = streaming && !hasContent ? tools.length - 1 : -1;
  const working = streaming && !hasContent;

  // Folded the moment prose starts, not when the stream ends: the answer then
  // shifts once, at the same instant the skeleton is replaced, instead of
  // sliding up again after the last token. A manual toggle outranks this —
  // never fight the user's click.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? false;

  const elapsed = useElapsed(working, turn.startedAt);
  const total =
    turn.startedAt && turn.endedAt ? turn.endedAt - turn.startedAt : null;

  if (tools.length === 0 && !working) return null;

  /** A step ends when the next one starts (or when the turn does). */
  const durationOf = (i: number): string | null => {
    const start = tools[i]?.startedAt;
    if (!start) return null;
    const end = tools[i + 1]?.startedAt ?? turn.endedAt;
    if (!end || end <= start) return null;
    return formatDuration(end - start);
  };

  const steps = tools.length > 0 && (open || working) ? (
    <ul className="mt-1.5 space-y-px border-l border-border/70 pl-3">
      {tools.map((t, i) => (
        <StepRow
          key={`${i}-${t.query}`}
          tool={t}
          running={i === runningIndex}
          duration={durationOf(i)}
        />
      ))}
    </ul>
  ) : null;

  // ── Settled: one collapsed line that can be reopened ──────────────────────
  if (!working) {
    return (
      <div className="mb-3 font-sans">
        <button
          type="button"
          onClick={() => setManualOpen(!open)}
          aria-expanded={open}
          className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-border hover:bg-card/70 hover:text-foreground/80"
        >
          <Check className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="truncate">
            {summaryLabel(tools, turn.mode)}
            <span className="text-muted-foreground/60">
              {" · "}
              {tools.length} {tools.length === 1 ? "query" : "queries"}
              {total ? ` · ${formatDuration(total)}` : ""}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="overflow-hidden"
            >
              {steps}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  // ── Live: header + timeline + indeterminate sweep ─────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="relative mb-3 overflow-hidden rounded-xl border border-border/70 bg-card/50 px-3 pb-3 pt-2.5 font-sans"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/80" />
        <span className="text-shimmer text-[13px] font-medium">
          {runningLabel(tools, turn.mode)}
        </span>
        {/* Hidden from the live region: at 10 Hz it would otherwise be
            announced continuously, drowning out the label that matters. */}
        <span
          aria-hidden
          className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/60"
        >
          {formatDuration(elapsed)}
        </span>
      </div>
      {steps}
      <span className="progress-track" aria-hidden>
        <span className="progress-bar" />
      </span>
    </motion.div>
  );
}

/** Placeholder for the answer itself while the first token is in flight. */
export function AnswerSkeleton() {
  return (
    <div className="space-y-2.5 py-1" aria-hidden>
      {/* Two lines, not three: the first streamed line replaces this, and a
          taller placeholder makes the answer jump up as it arrives. */}
      <span className="skeleton-line h-3.5 w-[92%]" />
      <span className="skeleton-line h-3.5 w-[64%]" />
    </div>
  );
}
