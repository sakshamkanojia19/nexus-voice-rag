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

/** Within this distance of the bottom counts as "at the bottom". */
const FOLLOW_SLACK_PX = 80;
/** Long enough for a browser smooth scroll to finish. */
const SMOOTH_SCROLL_MS = 450;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export function Conversation({ messages, voiceState, voiceInterim, onSpeak, speakingId }: ConversationProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom while the user is there; let go the moment they scroll
  // up to read. This used to start a *smooth* scroll on every content change —
  // with Groq that is dozens a second, and Chrome restarts each one, which is
  // the stutter, and it dragged a reader back down mid-sentence.
  const followRef = useRef(true);
  const ignoreScrollUntilRef = useRef(0);

  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollParent(root);
    if (!root || !scroller) return;
    const onScroll = () => {
      if (performance.now() < ignoreScrollUntilRef.current) return;
      followRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK_PX;
    };
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!followRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (performance.now() < ignoreScrollUntilRef.current) return;
        scroller.scrollTop = scroller.scrollHeight;
      });
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(root);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // A new turn (the user just sent something) always brings the view down —
  // smoothly, once, with scroll tracking paused so the animation's own
  // intermediate positions are not mistaken for the user scrolling away.
  useEffect(() => {
    followRef.current = true;
    ignoreScrollUntilRef.current = performance.now() + SMOOTH_SCROLL_MS;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length]);

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
