import { useEffect, useRef, useState } from "react";
import { ArrowUp, AudioLines, Check, Lightbulb, Mic, Plus, Search, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/useVoice";
import type { VoiceOption } from "@/hooks/useSpeech";
import type { DocumentMeta, SearchMode } from "@/lib/api";
import { SpeechMenu } from "./SpeechMenu";
import { DocMenu } from "./DocMenu";
import { SearchModes } from "./SearchModes";
import { ModelMenu } from "./ModelMenu";
import { SearchSuggestions } from "./SearchSuggestions";
import { useSuggestions } from "@/hooks/useSuggestions";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  /** Sends `text` when given, otherwise the current field value. Picking a
   *  suggestion must pass it explicitly — the parent's state hasn't updated
   *  yet on the same tick. */
  onSend: (text?: string) => void;
  onStop?: () => void;
  isStreaming: boolean;
  onMicToggle: () => void;
  /** Abandon the recording without using what was heard. Falls back to
   *  `onMicToggle` when absent, but then a mis-tapped mic can't be undone. */
  onVoiceCancel?: () => void;
  voiceState: VoiceState;
  voiceSupported: boolean;
  ttsEnabled: boolean;
  ttsVoiceName?: string | null;
  onTtsToggle: () => void;
  onTtsTest?: () => void;
  voices: VoiceOption[];
  selectedVoice: string | null;
  onSelectVoice: (name: string | null) => void;
  onAttachFiles?: (files: FileList) => void;
  documents?: DocumentMeta[];
  onRemoveDoc?: (docId: string) => void;
  isDocSelected?: (docId: string) => boolean;
  onToggleDoc?: (docId: string) => void;
  /** Enter the full-screen, hands-free live voice chat. */
  onStartVoiceChat?: () => void;
  /** Conversation language (STT + reply language). */
  lang?: string;
  onLangChange?: (code: string) => void;
  variant?: "hero" | "docked";
  heroPlaceholder?: string;
  autoFocus?: boolean;
  /** Search mode — decides the agent's tools and iteration budget. */
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  thinking: boolean;
  onThinkingChange: (on: boolean) => void;
  /** Available model ids from the server allowlist; empty hides the picker. */
  models: string[];
  model: string | null;
  onModelChange: (model: string | null) => void;
}

/** Live input level, as five bars. CSS-only — `ucb-bar` already exists, and a
 *  Lottie file is a lot of bytes for something four divs can do. */
function VoiceBars() {
  return (
    <span className="flex h-4 items-center gap-[3px]" aria-hidden>
      {[0, 0.18, 0.36, 0.12, 0.28].map((delay, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-primary"
          style={{
            height: i === 2 ? "100%" : i % 2 === 0 ? "62%" : "80%",
            animation: `ucb-bar 900ms ${delay}s ease-in-out infinite`,
          }}
        />
      ))}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The dictation state, shown in place of the toolbar while the mic is open.
 *
 * It replaces four separate indicators that used to fire at once — a floating
 * pill above the bar, a "Listening… speak now" placeholder, a pulsing red stop
 * button and a red border. Four signals for one state is not emphasis, it is
 * noise, and it left no room for the two things actually worth showing.
 *
 * Those two: an **elapsed timer**, which is how you tell a live mic from a hung
 * one, and a **discard** action. Previously the only way out was "stop and
 * send" — mis-tap the mic and you had to let it transcribe, then clear the
 * field by hand. ChatGPT and Claude both offer cancel-or-accept here, and the
 * reason is that dictation is the one input people start by accident.
 *
 * Colour is the accent, not `destructive`. Red means "this will delete
 * something"; spending it on "the microphone is on" leaves nothing to say the
 * real thing with — so red appears only on the discard button's hover.
 */
function DictationBar({
  startedAt,
  onDiscard,
  onDone,
}: {
  startedAt: number;
  onDiscard: () => void;
  onDone: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-3">
      <VoiceBars />
      <span className="text-[13px] font-medium text-foreground/90">Listening</span>
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
        {formatElapsed(now - startedAt)}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Discard recording"
          title="Discard"
          onClick={onDiscard}
          className="rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-4" />
        </Button>
        <Button
          type="button"
          variant="gradient"
          size="icon-sm"
          aria-label="Stop listening and use this text"
          title="Done"
          onClick={onDone}
          className="rounded-full"
        >
          <Check className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  onMicToggle,
  onVoiceCancel,
  voiceState,
  voiceSupported,
  ttsEnabled,
  ttsVoiceName,
  onTtsToggle,
  onTtsTest,
  voices,
  selectedVoice,
  onSelectVoice,
  onAttachFiles,
  documents = [],
  onRemoveDoc,
  isDocSelected,
  onToggleDoc,
  onStartVoiceChat,
  lang,
  onLangChange,
  variant = "docked",
  heroPlaceholder,
  autoFocus,
  mode,
  onModeChange,
  thinking,
  onThinkingChange,
  models,
  model,
  onModelChange,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isHero = variant === "hero";
  const isListening = voiceState === "listening";
  const isTranscribing = voiceState === "transcribing";
  const isBusy = isListening || isTranscribing;

  // Stamped when the mic opens so the timer counts this take, not the page's
  // lifetime. Reset on each new recording rather than accumulated.
  const [listeningSince, setListeningSince] = useState(0);
  useEffect(() => {
    if (isListening) setListeningSince(Date.now());
  }, [isListening]);

  // Autocomplete is a hero-only affordance: it helps you phrase an opening
  // query, but a follow-up in an ongoing thread is about the conversation, not
  // about what the web is searching for.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const suggestions = useSuggestions(value, isHero && !isBusy && !isStreaming, lang);
  const showSuggestions = suggestions.length > 0 && dismissed !== value;

  // A new list invalidates the old highlight — otherwise index 3 of the
  // previous query silently becomes index 3 of a different one.
  useEffect(() => setActiveIndex(-1), [suggestions]);

  const pick = (text: string) => {
    setDismissed(text);
    onChange(text);
    onSend(text);
  };

  // Auto-grow the field. In hero the ceiling scales with the viewport so short
  // laptops don't get a box that shoves the toolbar off-screen, while tall
  // displays get room to write a real paragraph before it starts scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => {
      const cap = isHero ? Math.min(360, Math.max(180, window.innerHeight * 0.3)) : 140;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    };
    resize();
    if (!isHero) return;
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value, isHero]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const placeholder = isListening
    ? "Speak now"
    : isTranscribing
      ? "Transcribing…"
      : isHero
        ? heroPlaceholder || "Ask anything — grounded in your documents and the web…"
        : "Ask a follow-up…";

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-2.5 rounded-3xl border bg-card transition-colors",
        "border-border/80 focus-within:border-primary/45",
        isHero ? "px-4 py-4 shadow-soft md:px-5 md:py-5" : "px-3 py-2.5 shadow-soft rounded-2xl",
        isListening && "border-primary/45",
      )}
    >
      {/* Input row */}
      <div className="flex items-start gap-2.5">
        {isHero ? <Search className="mt-1.5 size-5 shrink-0 text-muted-foreground/70" /> : null}
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (showSuggestions) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
                return;
              }
              if (e.key === "Escape") {
                setDismissed(value);
                setActiveIndex(-1);
                return;
              }
              // Enter with nothing highlighted sends what was typed, so the
              // list never hijacks the normal way to submit.
              if (e.key === "Enter" && !e.shiftKey && activeIndex >= 0) {
                e.preventDefault();
                pick(suggestions[activeIndex]!);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!isBusy) onSend();
            }
          }}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          className={cn(
            "w-full resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60",
            isHero
              ? "min-h-[64px] pt-1 text-base sm:min-h-[80px] md:min-h-[96px] md:text-lg lg:min-h-[104px]"
              : "px-1 text-sm",
          )}
        />
      </div>

      {/* While dictating, the toolbar yields entirely. None of those controls
          apply mid-sentence, and keeping them visible is what made the state
          read as "several things are happening" rather than "I am listening". */}
      {isListening ? (
        <DictationBar
          startedAt={listeningSince}
          onDiscard={onVoiceCancel ?? onMicToggle}
          onDone={onMicToggle}
        />
      ) : (
      /* Toolbar row. Wraps rather than overflows: at ~11 controls this row is
         wider than a phone, and without wrapping the send button escapes the
         card's padding instead of moving to a second line. */
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
          {isHero ? (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Upload documents"
                aria-label="Upload documents"
                className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-4.5" />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.markdown,.text,.log,.csv"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) onAttachFiles?.(e.target.files);
                  e.target.value = "";
                }}
              />
              <DocMenu
                documents={documents}
                onAttachFiles={onAttachFiles}
                onRemoveDoc={onRemoveDoc ?? (() => {})}
                isSelected={isDocSelected ?? (() => true)}
                onToggleSelect={onToggleDoc ?? (() => {})}
              />
              <SearchModes value={mode} onChange={onModeChange} />
            </>
          ) : (
            <SearchModes value={mode} onChange={onModeChange} />
          )}
        </div>

        <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
          {/* Instant runs a single toolless pass, so there is nothing to reason
              over — the toggle stays visible but inert rather than silently
              doing nothing when pressed. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={thinking ? "Disable thinking mode" : "Enable thinking mode"}
            aria-pressed={thinking}
            disabled={mode === "instant"}
            title={
              mode === "instant"
                ? "Thinking Mode is unavailable in Instant Search"
                : "Thinking Mode — enable step-by-step reasoning"
            }
            onClick={() => onThinkingChange(!thinking)}
            className={cn(
              "rounded-full",
              thinking ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Lightbulb />
          </Button>

          {isHero ? (
            <ModelMenu
              models={models}
              value={model}
              onChange={onModelChange}
              disabled={thinking}
              disabledHint="Thinking Mode picks a reasoning model"
            />
          ) : null}

          <SpeechMenu
            lang={lang}
            onLangChange={onLangChange}
            voices={voices}
            selectedVoice={selectedVoice}
            activeVoiceName={ttsVoiceName ?? null}
            onSelectVoice={onSelectVoice}
            ttsEnabled={ttsEnabled}
            onTtsToggle={onTtsToggle}
            onTtsTest={onTtsTest}
          />

          {voiceSupported && onStartVoiceChat ? (
            <button
              type="button"
              aria-label="Start live voice chat"
              title="Live voice chat — hands-free, like a call"
              onClick={onStartVoiceChat}
              className="flex size-9 items-center justify-center rounded-full bg-brand-gradient text-white shadow-glow transition-transform hover:scale-105 active:scale-95"
            >
              <AudioLines className="size-4" />
            </button>
          ) : null}

          {voiceSupported ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Start voice input"
              title="Dictate"
              onClick={onMicToggle}
              disabled={isTranscribing}
              className="rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Mic />
            </Button>
          ) : null}

          {isStreaming ? (
            <Button type="button" variant="outline" size="icon" aria-label="Stop generating" title="Stop" onClick={onStop} className="rounded-full">
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="gradient"
              size="icon"
              aria-label="Send message"
              onClick={() => onSend()}
              disabled={isBusy || !value.trim()}
              className="rounded-full"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
      )}

      {showSuggestions ? (
        <SearchSuggestions
          items={suggestions}
          query={value}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={pick}
        />
      ) : null}
    </div>
  );
}
