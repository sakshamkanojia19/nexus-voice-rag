import { motion } from "framer-motion";
import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceOption } from "@/hooks/useSpeech";
import { VoiceOrb, type VoiceVizState } from "./VoiceOrb";
import { VoiceMenu } from "./VoiceMenu";
import { LanguageMenu } from "./LanguageMenu";

interface VoiceChatPageProps {
  state: VoiceVizState;
  getLevel: () => number;
  /** Spoken-word energy, so the orb moves with the reply being read out. */
  getSpeechPulse: () => number;
  botName: string;
  /** True while a thinking pause is being waited out mid-sentence. */
  holdingForSpeech?: boolean;
  micMuted: boolean;
  onToggleMic: () => void;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  /** Tap the orb to interrupt the assistant while it's speaking. */
  onInterrupt: () => void;
  onEnd: () => void;
  // Voice + language pickers (live, mid-call).
  voices: VoiceOption[];
  selectedVoice: string | null;
  activeVoiceName: string | null;
  onSelectVoice: (name: string | null) => void;
  lang: string;
  onLangChange: (code: string) => void;
  /** Why the last turn failed, if it did. The call screen shows no transcript,
   *  so without this a refused request looks exactly like being ignored. */
  error?: string | null;
}

const STATUS: Record<VoiceVizState, string> = {
  idle: "Tap the mic to talk",
  listening: "Listening…",
  understanding: "Understanding…",
  thinking: "Thinking…",
  speaking: "Speaking… just talk to interrupt",
};

/** Shown instead of "Listening…" while a mid-sentence pause is being waited
 *  out. Without it the UI looks identical whether we are still listening or
 *  have quietly given up, which is exactly the anxiety that makes people
 *  rush their sentences. */
const HOLDING_LABEL = "Take your time…";

export function VoiceChatPage({
  state,
  getLevel,
  getSpeechPulse,
  botName,
  holdingForSpeech,
  micMuted,
  onToggleMic,
  ttsEnabled,
  onToggleTts,
  onInterrupt,
  onEnd,
  voices,
  selectedVoice,
  activeVoiceName,
  onSelectVoice,
  lang,
  onLangChange,
  error,
}: VoiceChatPageProps) {
  const statusLabel = error
    ? error
    : micMuted && state === "idle"
      ? "Mic paused"
      : holdingForSpeech && state === "listening"
        ? HOLDING_LABEL
        : STATUS[state];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="relative flex h-full w-full flex-col items-center justify-between px-6 py-10"
    >
      {/* Top-right live pickers: language + reply voice */}
      <div className="absolute right-5 top-5 z-10 flex items-center gap-2">
        <LanguageMenu value={lang} onChange={onLangChange} direction="down" />
        <VoiceMenu
          voices={voices}
          selectedVoice={selectedVoice}
          activeVoiceName={activeVoiceName}
          onSelect={onSelectVoice}
          disabled={!ttsEnabled}
          direction="down"
        />
      </div>

      {/* Header */}
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="font-display text-lg font-semibold text-foreground">{botName}</div>
      </div>

      {/* Center: animated orb */}
      <button
        type="button"
        onClick={state === "speaking" ? onInterrupt : undefined}
        title={state === "speaking" ? "Tap to interrupt" : undefined}
        className="group relative flex w-full max-w-3xl flex-1 items-center justify-center focus:outline-none"
      >
        {/* Ambient bloom seated behind the orb — wide and weak, so it lifts the
            sphere off the background without competing with the core the orb
            draws for itself. Widened and dimmed against the old lattice values
            for exactly that reason. */}
        <div
          className={cn(
            "pointer-events-none absolute aspect-square w-[min(72vw,520px)] rounded-full blur-[110px] transition-opacity duration-700",
            state === "speaking"
              ? "bg-primary/20 opacity-70"
              : state === "listening"
                ? "bg-accent/15 opacity-60"
                : state === "thinking"
                  ? "bg-primary/15 opacity-50 animate-glow-pulse"
                  : "bg-primary/10 opacity-35",
          )}
        />
        <VoiceOrb
          state={state}
          getLevel={getLevel}
          getSpeechPulse={getSpeechPulse}
          className="relative aspect-square h-[clamp(240px,46vh,460px)] max-w-full"
        />
      </button>

      {/* Status, seated under the orb.
          Deliberately the ONLY text on this screen: a live transcript turns a
          voice call into something you read, and every partial STT result — echo
          and misfires included — becomes visible churn. The conversation is
          still written to history; this screen just isn't where you read it. */}
      <div className="mb-4 flex min-h-[3.5rem] w-full max-w-xl items-start justify-center px-2">
        <motion.p
          key={statusLabel}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
          aria-live="polite"
          className={cn(
            "text-sm",
            error ? "text-center text-destructive" : state === "listening" ? "text-primary" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </motion.p>
      </div>

      {/* Controls — mic · end · speaker */}
      <div className="flex items-center justify-center gap-7">
        <ControlButton
          label={micMuted ? "Unmute mic" : "Mute mic"}
          onClick={onToggleMic}
          active={!micMuted}
          tone="neutral"
        >
          {micMuted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
        </ControlButton>

        <button
          type="button"
          onClick={onEnd}
          aria-label="End voice chat"
          title="End voice chat"
          className="flex size-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-[0_0_28px_-4px_hsl(var(--destructive)/0.8)] transition-transform hover:scale-105 active:scale-95"
        >
          <PhoneOff className="size-7" />
        </button>

        <ControlButton
          label={ttsEnabled ? "Mute replies" : "Unmute replies"}
          onClick={onToggleTts}
          active={ttsEnabled}
          tone="neutral"
        >
          {ttsEnabled ? <Volume2 className="size-6" /> : <VolumeX className="size-6" />}
        </ControlButton>
      </div>
    </motion.div>
  );
}

function ControlButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  tone?: "neutral";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "flex size-14 items-center justify-center rounded-full border transition-all hover:scale-105 active:scale-95",
        active
          ? "border-border bg-muted/70 text-foreground"
          : "border-border bg-card text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}
