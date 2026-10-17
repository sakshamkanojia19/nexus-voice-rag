import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import type { ChatTurn } from "@/hooks/useChat";
import type { VoiceState } from "@/hooks/useVoice";
import { MessageItem } from "./MessageItem";

interface ConversationProps {
  messages: ChatTurn[];
  voiceState: VoiceState;
  voiceInterim: string;
  /** Toggle read-aloud for a message: starts it, or stops it if already playing. */
  onSpeak?: (turn: ChatTurn) => void;
  /** Id of the message currently being read, if any. */
  speakingId?: string | null;
}

export function Conversation({ messages, voiceState, voiceInterim, onSpeak, speakingId }: ConversationProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, last?.content, last?.tools?.length]);

  // GSAP entrance when we transition from the hero into the conversation view.
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.from(rootRef.current, { opacity: 0, y: 22, duration: 0.5, ease: "power3.out" });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={rootRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      {messages.map((turn) => (
        <MessageItem
          key={turn.id}
          turn={turn}
          onSpeak={onSpeak}
          speaking={speakingId === turn.id}
        />
      ))}

      {voiceState === "transcribing" ? (
        <div className="flex justify-center">
          <span className="text-shimmer text-[12px] font-medium" role="status">
            Transcribing
          </span>
        </div>
      ) : null}

      {voiceState === "listening" && voiceInterim ? (
        <div className="flex w-full justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md border border-border/70 border-dashed bg-muted/25 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-muted-foreground">
            {voiceInterim}
          </div>
        </div>
      ) : null}

      <div ref={bottomRef} className="h-px" />
    </div>
  );
}
