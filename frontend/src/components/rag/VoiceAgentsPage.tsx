import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Check, Search, Sparkles, Volume2, WifiOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { greetingFor, voicesToAgents, type VoiceAgent } from "@/lib/agents";
import type { VoiceOption } from "@/hooks/useSpeech";
import { AgentAvatar } from "./AgentAvatar";

interface VoiceAgentsPageProps {
  voices: VoiceOption[];
  selectedVoice: string | null;
  speakingVoice?: string | null;
  onSelect: (agent: VoiceAgent) => void;
  /** Clear the explicit pick — back to "best available, offline first". */
  onUseAuto: () => void;
  onClose: () => void;
}

/**
 * The full voice roster as a dedicated page: every persona, searchable and
 * filterable by accent. The hero strip is the teaser (a dozen varied voices);
 * this is the catalogue, so nothing here is trimmed. Cards preview on click —
 * the same select-and-hear behaviour as the strip, because hearing the voice
 * IS the browsing.
 */
export function VoiceAgentsPage({
  voices,
  selectedVoice,
  speakingVoice,
  onSelect,
  onUseAuto,
  onClose,
}: VoiceAgentsPageProps) {
  const agents = useMemo(() => voicesToAgents(voices), [voices]);
  const [query, setQuery] = useState("");
  const [accent, setAccent] = useState<string | null>(null);

  // Accent chips, most-populated first, capped so rare languages go through
  // search instead of exploding the chip row.
  const accents = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(a.accent, (counts.get(a.accent) ?? 0) + 1);
    return [...counts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([name]) => name);
  }, [agents]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (accent && a.accent !== accent) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.accent.toLowerCase().includes(q) ||
        a.voiceLabel.toLowerCase().includes(q)
      );
    });
  }, [agents, query, accent]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10"
    >
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Voice Agents · {agents.length}
          </div>
          <h2 className="font-display text-3xl font-semibold">
            Pick a <span className="text-gradient">voice</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Click any agent to hear them. Your pick reads every reply aloud — change it anytime.
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <X className="size-5" />
        </button>
      </div>

      {/* Auto row — the recommended default, styled as a banner not a card. */}
      <button
        onClick={onUseAuto}
        className={cn(
          "mb-5 flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
          selectedVoice === null
            ? "border-primary/55 bg-primary/[0.09]"
            : "border-border/70 bg-card/60 hover:border-primary/35 hover:bg-card",
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Auto (recommended)</span>
          <span className="block text-[11px] text-muted-foreground">
            Best available voice for your language — on-device first, so it always works
          </span>
        </span>
        {selectedVoice === null ? (
          <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" />
          </span>
        ) : null}
      </button>

      {/* Search + accent filters */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search voices…"
            className="h-8 w-full rounded-full border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none sm:w-52"
          />
        </div>
        <FilterChip label="All" active={accent === null} onClick={() => setAccent(null)} />
        {accents.map((a) => (
          <FilterChip key={a} label={a} active={accent === a} onClick={() => setAccent(accent === a ? null : a)} />
        ))}
      </div>

      {/* Roster grid */}
      {shown.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-5 text-xs text-muted-foreground">
          <Volume2 className="size-5 shrink-0 text-primary/70" />
          {agents.length === 0
            ? "No speech voices are available in this browser yet — Chrome or Edge on desktop ship several on-device and cloud voices."
            : "No voices match — try a different search or clear the filter."}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 pb-10 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((a, i) => (
            <PageAgentCard
              key={a.id}
              agent={a}
              index={i}
              selected={a.voiceName === selectedVoice}
              speaking={a.voiceName === speakingVoice}
              onSelect={() => onSelect(a)}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-8 rounded-full border px-3 text-xs transition-colors",
        active
          ? "border-primary/55 bg-primary/[0.12] text-primary"
          : "border-border bg-card text-muted-foreground hover:border-primary/35 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function PageAgentCard({
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
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.35), duration: 0.35, ease: "easeOut" }}
      onClick={onSelect}
      title={`Hear ${agent.name} — ${agent.voiceLabel}`}
      className={cn(
        "group/agent relative flex flex-col items-center rounded-2xl border px-3 pb-4 pt-5 text-center",
        "transition-[transform,border-color,background-color,box-shadow] duration-300 ease-out hover:-translate-y-1",
        selected
          ? "border-primary/55 bg-primary/[0.09] shadow-glow"
          : "border-border/70 bg-card/70 hover:border-primary/35 hover:bg-card",
      )}
    >
      {selected ? (
        <span className="absolute right-2.5 top-2.5 inline-flex size-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" />
        </span>
      ) : (
        <span className="absolute right-2.5 top-2.5 text-muted-foreground/0 transition-colors group-hover/agent:text-muted-foreground">
          <Volume2 className="size-3.5" />
        </span>
      )}

      <div className="relative">
        <AgentAvatar
          agent={agent}
          size={96}
          active={selected}
          speaking={speaking}
          className="transition-transform duration-300 group-hover/agent:scale-[1.05]"
        />
        {/* Greeting bubble in the persona's own language */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -right-4 -top-1 z-10 whitespace-nowrap rounded-xl rounded-bl-sm",
            "border border-border/70 px-2 py-0.5 text-[10.5px] font-medium text-foreground shadow-soft surface",
            "origin-bottom-left scale-75 opacity-0 transition-all duration-200 ease-out",
            "group-hover/agent:scale-100 group-hover/agent:opacity-100",
            selected && "scale-100 opacity-100",
          )}
        >
          {greetingFor(agent.lang)}
        </span>
      </div>

      <div className="mt-2 font-display text-[16px] font-semibold leading-tight text-foreground">{agent.name}</div>
      <div className="mt-1 flex items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", agent.offline ? "bg-success" : "bg-warning")}
          title={agent.offline ? "Works offline / on-device" : "Cloud voice — needs internet"}
        />
        <span className="truncate">{agent.accent}</span>
        {agent.offline ? <WifiOff className="size-3 shrink-0 text-success/70" /> : null}
      </div>
      <div className="mt-1.5 line-clamp-1 w-full text-[10px] text-muted-foreground/60" title={agent.voiceLabel}>
        {agent.voiceLabel}
      </div>
    </motion.button>
  );
}
