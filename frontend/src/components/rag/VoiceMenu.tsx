import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentsByVoiceName } from "@/lib/agents";
import type { VoiceOption } from "@/hooks/useSpeech";

interface VoiceMenuProps {
  voices: VoiceOption[];
  selectedVoice: string | null; // explicit choice, null = Auto
  activeVoiceName: string | null; // the voice actually in use
  onSelect: (name: string | null) => void;
  disabled?: boolean;
  /** "up" opens above the trigger (composer), "down" below (call screen). */
  direction?: "up" | "down";
}

/** Compact popover to switch the TTS voice. Offline (downloaded) voices are
 *  marked — they're the loud/fast ones that always work without network. */
export function VoiceMenu({ voices, selectedVoice, activeVoiceName, onSelect, disabled, direction = "up" }: VoiceMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The same persona names the agent cards use. Raw OS voice names ("Microsoft
  // Zira - English (United States)") tell a user nothing about which voice
  // they liked — the persona name is the identity they actually remember.
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

  const label = selectedVoice
    ? agents.get(selectedVoice)?.name ??
      selectedVoice.replace(/^(Microsoft|Google)\s+/i, "").replace(/\s+(Online|Desktop).*$/i, "")
    : "Auto";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Choose the voice that reads replies aloud"
        aria-label="Choose voice"
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50",
          open && "border-primary/50 text-foreground",
        )}
      >
        <span className="max-w-[88px] truncate">{label}</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className={cn(
          "surface absolute right-0 z-50 w-60 overflow-hidden rounded-xl border border-border shadow-soft",
          direction === "up" ? "bottom-full mb-2" : "top-full mt-2",
        )}>
          <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reply voice
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <VoiceRow
              label="Auto (recommended)"
              hint="Best available, offline first"
              active={selectedVoice === null}
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            />
            {voices.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">No voices detected.</div>
            ) : (
              voices.map((v) => {
                const agent = agents.get(v.name);
                return (
                  <VoiceRow
                    key={v.name}
                    label={agent?.name ?? v.name.replace(/^(Microsoft|Google)\s+/i, "")}
                    // The real system voice stays one hover away, for transparency.
                    title={v.name}
                    icon={
                      v.offline ? (
                        <WifiOff className="size-3 text-success" />
                      ) : (
                        <Wifi className="size-3 text-warning" />
                      )
                    }
                    hint={agent?.accent ?? (v.offline ? "Offline" : "Online")}
                    active={selectedVoice === v.name}
                    current={activeVoiceName === v.name && selectedVoice === null}
                    onClick={() => {
                      onSelect(v.name);
                      setOpen(false);
                    }}
                  />
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function VoiceRow({
  label,
  hint,
  icon,
  active,
  current,
  title,
  onClick,
}: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  active?: boolean;
  current?: boolean;
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
      {hint ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{current ? "in use" : hint}</span>
      ) : null}
    </button>
  );
}
