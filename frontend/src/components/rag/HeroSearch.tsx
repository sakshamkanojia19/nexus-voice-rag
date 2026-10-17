import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { AudioLines, FolderOpen } from "lucide-react";
import { NexusLogo } from "@/components/brand/NexusLogo";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { useTypewriter } from "@/hooks/useTypewriter";
import { Composer } from "./Composer";

interface HeroSearchProps {
  composerProps: React.ComponentProps<typeof Composer>;
  onShowDocuments: () => void;
  onShowVoices: () => void;
  voicesOpen?: boolean;
  /** Signed-in first name — turns the headline personal ("Good evening, Saksham"). */
  greetingName?: string | null;
}

/**
 * The headline greets the person, not the product — the pattern every mature
 * chat app converged on, because the brand belongs in the corner once someone
 * is inside. Time-aware so the page feels alive across the day.
 */
function timeGreeting(name?: string | null): string {
  const hour = new Date().getHours();
  // Night is one band wrapping midnight (22:00–04:59), not two — at 11pm
  // "Good evening" is plainly wrong, and "Good night" reads as a goodbye in
  // English, so the late hours get their own friendlier phrase.
  const part =
    hour >= 22 || hour < 5
      ? "Up late"
      : hour < 12
        ? "Good morning"
        : hour < 17
          ? "Good afternoon"
          : "Good evening";
  return name ? `${part}, ${name}` : part;
}

const PROMPTS = [
  "How does blockchain technology work?",
  "Summarize the key points of my document",
  "What are today's top news stories?",
  "Latest breakthroughs in AI research",
  "Compare my report to current best practices",
];

export function HeroSearch({
  composerProps,
  onShowDocuments,
  onShowVoices,
  voicesOpen,
  greetingName,
}: HeroSearchProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Animate only while the field is empty and the mic isn't active.
  const typing = useTypewriter(
    PROMPTS,
    composerProps.value.trim().length > 0 || composerProps.voiceState !== "idle",
  );

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      const els = gsap.utils.toArray<HTMLElement>("[data-hero]");
      if (reduce) {
        gsap.set(els, { opacity: 1, y: 0 });
        return;
      }
      gsap.set(els, { opacity: 0, y: 20 });
      gsap.timeline({ defaults: { ease: "power3.out" } }).to(els, {
        opacity: 1,
        y: 0,
        duration: 0.7,
        stagger: 0.12,
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={rootRef}
      className="mx-auto flex w-full max-w-2xl grow flex-col items-center justify-center px-3 py-6 sm:px-4 sm:py-10 md:max-w-3xl"
    >
      {/* Compact brand row — the product signs the page, the greeting owns it. */}
      <div data-hero className="mb-6 flex select-none items-center gap-2.5">
        <NexusLogo className="size-7 rounded-[9px] shadow-glow" />
        <span className="font-display text-lg font-semibold lowercase tracking-tight">
          <span className="text-foreground">{config.appName.slice(0, -2)}</span>
          <span className="text-gradient">{config.appName.slice(-2)}</span>
        </span>
        <span className="font-display text-[11px] font-medium italic text-primary/70">beta</span>
      </div>

      {/* Personal, time-aware headline */}
      <div data-hero className="relative mb-8 w-full select-none px-2 text-center lg:mb-10">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground [text-wrap:balance] sm:text-5xl md:text-[3.4rem]">
          <span aria-hidden className="mr-2 inline-block align-middle text-gradient sm:mr-3">✳</span>
          {timeGreeting(greetingName)}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground sm:text-base">
          Ask anything — or just start talking.
        </p>
      </div>

      {/* Search bar with a soft, static ambient glow (minimal — no pulsing).
          The glow's overhang shrinks on phones — at -inset-x-10 it was wider
          than the viewport. */}
      <div data-hero className="relative w-full">
        <div className="pointer-events-none absolute -inset-x-2 -inset-y-3 rounded-[40px] bg-primary/10 blur-3xl sm:-inset-x-10 sm:-inset-y-6" />
        <div className="relative">
          <Composer {...composerProps} variant="hero" heroPlaceholder={typing ? `${typing}▏` : undefined} autoFocus />
        </div>
      </div>

      {/* Bottom pills */}
      <div data-hero className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        <button
          onClick={onShowDocuments}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground transition-all hover:border-primary/40 hover:text-foreground"
        >
          <FolderOpen className="size-4" /> Documents
        </button>
        <button
          onClick={onShowVoices}
          aria-expanded={!!voicesOpen}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-all",
            voicesOpen
              ? "border-primary/50 bg-primary/12 text-foreground shadow-glow"
              : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
          )}
        >
          <AudioLines className="size-4" /> Voice Agents
        </button>
      </div>
    </div>
  );
}
