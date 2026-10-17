import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, Volume2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { greetingFor, topAgents, voicesToAgents, type VoiceAgent } from "@/lib/agents";
import type { VoiceOption } from "@/hooks/useSpeech";
import { AgentAvatar } from "./AgentAvatar";

/** The strip is a teaser, not the catalogue: a dozen varied voices to try, and
 *  a "view all" tile through to the dedicated page for the rest. */
const STRIP_LIMIT = 12;

interface VoiceAgentsStripProps {
  open: boolean;
  voices: VoiceOption[];
  selectedVoice: string | null;
  speakingVoice?: string | null;
  onSelect: (agent: VoiceAgent) => void;
  onClose: () => void;
  /** Navigate to the full Voice Agents page. */
  onShowAll?: () => void;
  className?: string;
}

/**
 * The voice roster as an inline drawer — it expands in place beneath the hero
 * (or above the composer) rather than replacing the page, so picking a voice
 * never loses your place. Characters stand above their cards and greet you in
 * their own language on hover.
 */
export function VoiceAgentsStrip({
  open,
  voices,
  selectedVoice,
  speakingVoice,
  onSelect,
  onClose,
  onShowAll,
  className,
}: VoiceAgentsStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const allAgents = useMemo(() => voicesToAgents(voices), [voices]);
  // A dozen varied voices (one per language+gender first) — but the CURRENT
  // selection always shows, or picking from the full page would make the strip
  // render your chosen agent as simply missing.
  const agents = useMemo(() => {
    const top = topAgents(allAgents, STRIP_LIMIT);
    if (selectedVoice && !top.some((a) => a.voiceName === selectedVoice)) {
      const chosen = allAgents.find((a) => a.voiceName === selectedVoice);
      if (chosen) return [chosen, ...top.slice(0, STRIP_LIMIT - 1)];
    }
    return top;
  }, [allAgents, selectedVoice]);

  const syncEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft < 8);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(syncEdges);
    return () => cancelAnimationFrame(id);
  }, [open, agents.length, syncEdges]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const scrollBy = (dx: number) => scrollRef.current?.scrollBy({ left: dx, behavior: "smooth" });

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.section
          key="voice-strip"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
          className={cn("w-full overflow-hidden", className)}
          aria-label="Voice agents"
        >
          <div className="px-1 pt-5">
            {/* Header row */}
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Voice Agents
                {allAgents.length > 0 ? (
                  <span className="ml-2 font-sans text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
                    top {agents.length} of {allAgents.length}
                  </span>
                ) : null}
              </h2>
              <div className="flex items-center gap-0.5">
                <IconBtn onClick={() => scrollBy(-320)} label="Scroll left" disabled={atStart}>
                  <ChevronLeft className="size-4" />
                </IconBtn>
                <IconBtn onClick={() => scrollBy(320)} label="Scroll right" disabled={atEnd}>
                  <ChevronRight className="size-4" />
                </IconBtn>
                <IconBtn onClick={onClose} label="Close voice agents">
                  <X className="size-4" />
                </IconBtn>
              </div>
            </div>

            {agents.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-5 text-xs text-muted-foreground">
                <Volume2 className="size-5 shrink-0 text-primary/70" />
                No speech voices are available in this browser yet — Chrome or Edge on desktop ship
                several on-device and cloud voices.
              </div>
            ) : (
              <div className="relative">
                {/* Edge fades hint at more characters off-screen */}
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-y-0 left-0 z-20 w-10 bg-gradient-to-r from-background to-transparent transition-opacity",
                    atStart && "opacity-0",
                  )}
                />
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 z-20 w-10 bg-gradient-to-l from-background to-transparent transition-opacity",
                    atEnd && "opacity-0",
                  )}
                />

                <div
                  ref={scrollRef}
                  onScroll={syncEdges}
                  className="flex snap-x gap-3.5 overflow-x-auto overflow-y-visible px-0.5 pb-3 pt-[80px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {agents.map((a, i) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      index={i}
                      selected={a.voiceName === selectedVoice}
                      speaking={a.voiceName === speakingVoice}
                      onSelect={() => onSelect(a)}
                    />
                  ))}
                  {onShowAll && allAgents.length > agents.length ? (
                    <motion.button
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(agents.length * 0.045, 0.4), duration: 0.4, ease: "easeOut" }}
                      onClick={onShowAll}
                      title="See every voice agent"
                      className={cn(
                        "group/all relative flex w-[168px] shrink-0 snap-start flex-col items-center justify-center gap-2 self-stretch rounded-2xl",
                        "border border-dashed border-border/70 bg-card/40 text-center transition-colors duration-300",
                        "hover:border-primary/40 hover:bg-card",
                      )}
                    >
                      <span className="flex size-10 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors group-hover/all:border-primary/40 group-hover/all:text-primary">
                        <ChevronRight className="size-5" />
                      </span>
                      <span className="font-display text-sm font-semibold text-foreground">View all</span>
                      <span className="text-[10.5px] text-muted-foreground">
                        {allAgents.length - agents.length} more voices
                      </span>
                    </motion.button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

function AgentCard({
  agent,
  index,
  selected,
  speaking,
  onSelect,
}: {
  agent: VoiceAgent;
  index: number;
  selected: boolean;
  speaking: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.045, 0.4), duration: 0.4, ease: "easeOut" }}
      onClick={onSelect}
      title={`Hear ${agent.name} — ${agent.voiceLabel}`}
      className={cn(
        // pt clears the bust, which overhangs the card by 74px and is 118 tall.
        "group/agent relative flex w-[168px] shrink-0 snap-start flex-col items-center rounded-2xl border pb-4 pt-[52px] text-center",
        "transition-[transform,border-color,background-color,box-shadow] duration-300 ease-out hover:-translate-y-1.5",
        selected
          ? "border-primary/55 bg-primary/[0.09] shadow-glow"
          : "border-border/70 bg-card/70 hover:border-primary/35 hover:bg-card",
      )}
    >
      {/* Character stands above the card */}
      <div className="pointer-events-none absolute -top-[74px] left-1/2 -translate-x-1/2">
        <AgentAvatar
          agent={agent}
          size={118}
          active={selected}
          speaking={speaking}
          className="transition-transform duration-300 group-hover/agent:scale-[1.06]"
        />
      </div>

      {/* Greeting bubble, in the persona's own language */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-[58px] left-[calc(50%+38px)] z-10 whitespace-nowrap rounded-xl rounded-bl-sm",
          "border border-border/70 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-soft surface",
          "origin-bottom-left scale-75 opacity-0 transition-all duration-200 ease-out",
          "group-hover/agent:scale-100 group-hover/agent:opacity-100",
          selected && "scale-100 opacity-100",
        )}
      >
        {greetingFor(agent.lang)}
      </span>

      {selected ? (
        <span className="absolute right-2.5 top-2.5 inline-flex size-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
      ) : (
        <span className="absolute right-2.5 top-2.5 text-muted-foreground/0 transition-colors group-hover/agent:text-muted-foreground">
          <Volume2 className="size-3.5" />
        </span>
      )}

      <div className="font-display text-[17px] font-semibold leading-tight text-foreground">{agent.name}</div>
      <div className="mt-1 flex items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", agent.offline ? "bg-success" : "bg-warning")}
          title={agent.offline ? "Works offline / on-device" : "Cloud voice — needs internet"}
        />
        <span className="truncate">{agent.accent}</span>
      </div>
    </motion.button>
  );
}

function IconBtn({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
