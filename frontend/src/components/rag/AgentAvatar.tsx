import { cn } from "@/lib/utils";
import type { VoiceAgent } from "@/lib/agents";

/**
 * Voice persona avatar: a colored bubble with the persona's initial.
 *
 * Deliberately simple — earlier versions drew illustrated character busts
 * (DiceBear Open Peeps), but a grid of detailed doodles read as visual noise
 * next to the voice metadata people actually pick by. A gradient circle keyed
 * to the agent's stable hue is calmer, loads instantly (no 270 kB avatar
 * library), and matches the app's orb language: the voice call screen, the
 * landing page agents, and this picker now all speak "colored bubble".
 *
 * The hue comes from `agent.hue` (assigned by index in lib/agents.ts), so a
 * given system voice keeps the same color across reloads.
 */

interface AgentAvatarProps {
  agent: VoiceAgent;
  size?: number;
  active?: boolean;
  speaking?: boolean;
  className?: string;
}

export function AgentAvatar({ agent, size = 120, active, speaking, className }: AgentAvatarProps) {
  const initial = ([...agent.name][0] ?? "?").toUpperCase();
  const hue = agent.hue;

  return (
    <div className={cn("relative grid place-items-center", className)} style={{ width: size, height: size }}>
      {/* Soft hue glow behind the bubble — brighter when selected. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-[6%] rounded-full blur-xl transition-opacity duration-300",
          active ? "opacity-70" : "opacity-30",
        )}
        style={{ background: `radial-gradient(circle, hsl(${hue} 80% 62% / 0.8), transparent 70%)` }}
      />

      <div
        className={cn(
          "relative grid select-none place-items-center rounded-full text-white transition-transform duration-300",
          speaking ? "animate-float" : "",
        )}
        style={{
          width: "82%",
          height: "82%",
          background: `radial-gradient(circle at 32% 28%, hsl(${hue} 88% 78%), hsl(${hue} 76% 58%) 55%, hsl(${hue} 68% 38%))`,
          boxShadow: `inset 0 1px 0 hsl(${hue} 90% 88% / .55), 0 10px 26px -10px hsl(${hue} 80% 55% / .6)`,
          fontSize: size * 0.3,
        }}
      >
        <span className="font-display font-semibold leading-none" style={{ textShadow: "0 1px 4px rgb(0 0 0 / .35)" }}>
          {initial}
        </span>
      </div>

      {/* Speaking indicator — a little equalizer at the bubble's edge. */}
      {speaking ? (
        <span className="absolute bottom-[8%] right-[4%] flex h-5 items-end gap-[2px] rounded-full bg-primary px-1.5 py-1 shadow-glow">
          {[0, 1, 2].map((b) => (
            <span
              key={b}
              className="w-[2px] rounded-full bg-primary-foreground"
              style={{ height: 8, animation: `ucb-bar .7s ${b * 0.12}s ease-in-out infinite`, transformOrigin: "center" }}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
