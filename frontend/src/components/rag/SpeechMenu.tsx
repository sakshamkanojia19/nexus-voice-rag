import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGES, findLang } from "@/lib/languages";
import { agentsByVoiceName } from "@/lib/agents";
import type { VoiceOption } from "@/hooks/useSpeech";

interface SpeechMenuProps {
  lang?: string;
  onLangChange?: (code: string) => void;
  voices: VoiceOption[];
  selectedVoice: string | null;
  activeVoiceName: string | null;
  onSelectVoice: (name: string | null) => void;
  ttsEnabled: boolean;
  onTtsToggle: () => void;
  onTtsTest?: () => void;
}

/**
 * Language, reply voice and mute behind one trigger.
 *
 * As three separate controls these cost ~226px of the composer's toolbar — the
 * difference between one row and two — and put two unrelated "Auto" labels side
 * by side. The trigger still renders the mute state, so the one piece of
 * at-a-glance information the old speaker button carried isn't lost.
 */
export function SpeechMenu({
  lang,
  onLangChange,
  voices,
  selectedVoice,
  activeVoiceName,
  onSelectVoice,
  ttsEnabled,
  onTtsToggle,
  onTtsTest,
}: SpeechMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = lang ? findLang(lang) : null;
  // Persona names, same mapping as the agent cards — see VoiceMenu for why.
  const agents = useMemo(() => agentsByVoiceName(voices), [voices]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const voiceLabel = selectedVoice
    ? agents.get(selectedVoice)?.name ??
      selectedVoice.replace(/^(Microsoft|Google)\s+/i, "").replace(/\s+(Online|Desktop).*$/i, "")
    : "Auto";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Speech settings"
        aria-expanded={open}
        title={`Speech — ${ttsEnabled ? "replies spoken" : "replies muted"}${current ? ` · ${current.label}` : ""}`}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-full px-1.5 transition-colors",
          ttsEnabled ? "text-primary hover:bg-primary/10" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        {ttsEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        // Two constraints, both learned from measuring:
        //  · Height is bounded by the room ABOVE the trigger, not the viewport.
        //    At 70vh the language list pushed the panel's top off-screen.
        //  · Anchor side follows the layout. Once the toolbar wraps, this
        //    trigger sits near the card's LEFT edge, and a right-anchored panel
        //    runs off the left of the screen; only on the single-row desktop
        //    layout is the trigger far enough right for right-0 to be correct.
        <div className="surface absolute bottom-full left-0 z-50 mb-2 flex w-64 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-border shadow-soft lg:left-auto lg:right-0">
          <button
            type="button"
            onClick={onTtsToggle}
            onDoubleClick={onTtsTest}
            className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-primary/10"
          >
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">Voice replies</span>
              <span className="block text-[10px] text-muted-foreground">
                {ttsEnabled ? "Answers are read aloud" : "Muted"}
              </span>
            </span>
            <span
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                ttsEnabled ? "bg-primary" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-all",
                  ttsEnabled ? "left-[1.125rem]" : "left-0.5",
                )}
              />
            </span>
          </button>

          <div className="max-h-[min(45vh,17rem)] min-h-0 flex-1 overflow-y-auto">
            {lang && onLangChange ? (
              <>
                <SectionLabel>Listen &amp; reply in</SectionLabel>
                {LANGUAGES.map((l) => (
                  <Row
                    key={l.code}
                    label={l.label}
                    hint={l.native}
                    active={l.code === lang}
                    onClick={() => onLangChange(l.code)}
                  />
                ))}
              </>
            ) : null}

            <SectionLabel>Reply voice</SectionLabel>
            <Row
              label="Auto (recommended)"
              hint="Offline first"
              active={selectedVoice === null}
              onClick={() => onSelectVoice(null)}
            />
            {voices.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">No voices detected.</p>
            ) : (
              voices.map((v) => {
                const agent = agents.get(v.name);
                return (
                  <Row
                    key={v.name}
                    label={agent?.name ?? v.name.replace(/^(Microsoft|Google)\s+/i, "")}
                    title={v.name}
                    icon={v.offline ? <WifiOff className="size-3 text-success" /> : <Wifi className="size-3 text-warning" />}
                    hint={
                      activeVoiceName === v.name && selectedVoice === null
                        ? "in use"
                        : agent?.accent ?? (v.offline ? "Offline" : "Online")
                    }
                    active={selectedVoice === v.name}
                    onClick={() => onSelectVoice(v.name)}
                  />
                );
              })
            )}
          </div>

          <p className="shrink-0 border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
            Voice: {voiceLabel}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 bg-popover px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Row({
  label,
  hint,
  icon,
  active,
  title,
  onClick,
}: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  active?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-primary/10",
        active ? "text-primary" : "text-foreground/90",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {active ? <Check className="size-3.5 text-primary" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-[10px] text-muted-foreground">{hint}</span> : null}
    </button>
  );
}
