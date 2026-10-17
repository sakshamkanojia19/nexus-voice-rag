import { useId } from "react";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * Nexus brand mark.
 *
 * The glyph is the letter **N** drawn as a node graph: four terminal nodes
 * joined by links, with a detached hub node sitting on the diagonal — the
 * "nexus" where documents, the web and the conversation meet. The hub is
 * punched out of the links with a mask so it stays a distinct node at large
 * sizes and gracefully collapses into a solid N at favicon sizes.
 *
 * Geometry lives on a 64×64 grid and is kept identical to `public/favicon.svg`.
 */

/** Glyph only, inherits `currentColor` — for placing inside an existing tile. */
export function NexusMark({ className }: { className?: string }) {
  const raw = useId();
  const maskId = `nexus-hub-${raw.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden focusable="false">
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <circle cx="32" cy="32" r="6.9" fill="#000" />
      </mask>
      <g mask={`url(#${maskId})`} stroke="currentColor" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 44V20l24 24V20" />
      </g>
      <g fill="currentColor">
        <circle cx="20" cy="20" r="5" />
        <circle cx="20" cy="44" r="5" />
        <circle cx="44" cy="20" r="5" />
        <circle cx="44" cy="44" r="5" />
        <circle cx="32" cy="32" r="5.8" />
      </g>
    </svg>
  );
}

/** Full lockup tile: gradient squircle + white glyph. Matches the favicon 1:1. */
export function NexusLogo({ className, title = "Nexus" }: { className?: string; title?: string }) {
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9]/g, "");
  const tileId = `nexus-tile-${uid}`;
  const shineId = `nexus-shine-${uid}`;
  const maskId = `nexus-mask-${uid}`;

  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={tileId} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8251F6" />
          <stop offset="0.55" stopColor="#BF4BF2" />
          <stop offset="1" stopColor="#F33FE4" />
        </linearGradient>
        <radialGradient id={shineId} cx="0.24" cy="0.16" r="0.85">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <circle cx="32" cy="32" r="6.9" fill="#000" />
        </mask>
      </defs>

      <rect width="64" height="64" rx="17" fill={`url(#${tileId})`} />
      <rect width="64" height="64" rx="17" fill={`url(#${shineId})`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="16.25" stroke="#fff" strokeOpacity="0.22" strokeWidth="1.5" />

      <g mask={`url(#${maskId})`} stroke="#fff" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 44V20l24 24V20" />
      </g>
      <g fill="#fff">
        <circle cx="20" cy="20" r="5" />
        <circle cx="20" cy="44" r="5" />
        <circle cx="44" cy="20" r="5" />
        <circle cx="44" cy="44" r="5" />
        <circle cx="32" cy="32" r="5.8" />
      </g>
    </svg>
  );
}

/**
 * Mark + serif wordmark, with the trailing two letters in the brand gradient.
 * `logo` swaps in a custom mark (e.g. the sidebar's interactive toggle).
 */
export function NexusWordmark({
  className,
  logo,
  logoClassName,
  textClassName,
}: {
  className?: string;
  logo?: React.ReactNode;
  logoClassName?: string;
  textClassName?: string;
}) {
  const name = config.appName;
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {logo ?? <NexusLogo className={cn("size-9 shrink-0 rounded-xl shadow-glow", logoClassName)} />}
      <span
        className={cn(
          "font-display text-2xl font-semibold lowercase leading-none tracking-tight",
          textClassName,
        )}
      >
        <span className="text-foreground">{name.slice(0, -2)}</span>
        <span className="text-gradient">{name.slice(-2)}</span>
      </span>
    </div>
  );
}
