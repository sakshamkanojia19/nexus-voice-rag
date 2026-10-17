import { useEffect, useRef } from "react";

export type VoiceVizState = "idle" | "listening" | "understanding" | "thinking" | "speaking";

interface VoiceOrbProps {
  state: VoiceVizState;
  /** Live mic loudness 0..1 — drives the orb while listening. */
  getLevel: () => number;
  /** Live TTS energy 0..1 — drives the orb while speaking. */
  getSpeechPulse?: () => number;
  className?: string;
}

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Voice visualizer: a slowly turning sphere of points.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Points are placed by the Fibonacci (golden-angle) spiral, which spaces them
 * evenly over a sphere with no clustering at the poles, then pushed to radii
 * biased toward the surface so the projected disc fills in instead of reading
 * as a hollow ring. Orthographic projection, drawn by hand onto a 2D canvas:
 * the look is flat dots and a soft core, which canvas draws natively and
 * exactly, and it keeps a 3D engine out of the bundle for one screen.
 *
 * The motion the design is built around is the BREATH — the whole sphere eases
 * outward and back. It is a sine, so there are no corners in it: the orb is
 * never not moving, and it never snaps. Everything else (spin, glow, per-point
 * travel) is layered on top of that one gesture.
 *
 * What the breath is *driven by* changes with the state, and only ever by one
 * thing at a time. Idle and thinking run a free sine on a 1.5–2s clock.
 * Listening and speaking hand the rhythm to live audio — the microphone, then
 * the voice — and the sine drops away beneath it. Running both at once was the
 * original mistake here: a 1.4s sine against a ~3-per-second word pulse beat
 * into a rhythm that was neither breathing nor talking.
 *
 * The states stay legible without reading the caption:
 *
 *   idle           barely turning, a shallow slow breath
 *   listening      breath deepens; the mic pushes points outward on top of it,
 *                  so the orb swells as you speak
 *   understanding  spin stops and the orb draws in — taking the question in
 *   thinking       REVERSES to anticlockwise and tightens: the turn has passed
 *                  to the machine, and the direction change is what says so
 *   speaking       the sine all but switches off and each spoken word inflates
 *                  the sphere directly, so the orb mouths the reply. Because
 *                  the envelope follows the measured word rate, slow speech
 *                  gives deep swells and fast speech quick shallow ones —
 *                  the cadence you hear is the cadence you see.
 *
 * Angular velocity is eased rather than set, so a reversal winds down through
 * zero and back up instead of snapping.
 *
 * Cost control: every frame is drawn in ~10 batched canvas calls (points
 * bucketed by depth) rather than one call per dot, all geometry lives in
 * preallocated typed arrays, and nothing is allocated inside the point loop.
 */

// ── Geometry ─────────────────────────────────────────────────────────────────
/** The golden angle — successive points advance by this much around the axis,
 *  which is what makes the spiral cover the sphere without seams or clumps. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** A low-discrepancy step (the plastic-number conjugate). Walking it and taking
 *  the fractional part scatters radii evenly without a random generator, so the
 *  sphere is identical on every mount. */
const RADIUS_STEP = 0.7548776662466927;
/** Camera pitch. Enough that the spiral's axis is not aimed at the viewer —
 *  dead-on, the poles read as a bullseye. */
const TILT = 0.34;
/** Innermost shell, as a fraction of the radius. Points fill the band between
 *  this and 1.0, cube-root weighted so density stays even by volume and the
 *  surface still reads as the edge of a solid. Tuned by measuring projected
 *  points-per-unit-area: 0.45 is the flattest profile (2.0x centre-to-rim)
 *  that keeps a slight outer emphasis — raise it and the middle reads hollow. */
const CORE_RADIUS = 0.45;

/** Classic ease between two edges. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ── Per-state targets ────────────────────────────────────────────────────────
interface Tuning {
  /** Yaw velocity in rad/s. Positive spins one way, negative the other. */
  yaw: number;
  /** Breath depth, as a fraction of the radius. */
  breath: number;
  /** Breath rate in Hz. 0.5–0.67 Hz is the 1.5–2s cycle the design asks for. */
  breathHz: number;
  /** How far a travelling ripple carries a point, in model units. */
  ripple: number;
  /** Overall size, so the orb also draws breath between states. */
  scale: number;
  /** Opacity ceiling for the points. */
  dot: number;
  /** Strength of the soft core behind the points. */
  glow: number;
  /**
   * How much of the swell comes from live energy — the mic while listening, the
   * spoken word while speaking — rather than from the free-running sine.
   *
   * While speaking this is the whole effect and `breath` drops nearly to zero.
   * Running both at once was the original mistake: a 1.4s sine and a ~3/sec word
   * pulse beat against each other, and the result read as neither breathing nor
   * talking. One rhythm at a time, and during a reply the rhythm is the voice.
   */
  drive: number;
}

const STATE_TUNING: Record<VoiceVizState, Tuning> = {
  idle:          { yaw:  0.10, breath: 0.020, breathHz: 0.50, ripple: 0.010, scale: 0.96, dot: 0.62, glow: 0.34, drive: 0.00 },
  listening:     { yaw:  0.20, breath: 0.040, breathHz: 0.64, ripple: 0.022, scale: 1.02, dot: 0.90, glow: 0.62, drive: 0.06 },
  // Understanding sits between listening and thinking, and reads as a held
  // breath: the spin has stopped and the orb has drawn in slightly, but it has
  // not yet reversed. It is the moment of taking the question in.
  understanding: { yaw:  0.04, breath: 0.034, breathHz: 0.55, ripple: 0.014, scale: 0.98, dot: 0.84, glow: 0.58, drive: 0.00 },
  thinking:      { yaw: -0.52, breath: 0.026, breathHz: 0.88, ripple: 0.018, scale: 0.94, dot: 0.78, glow: 0.48, drive: 0.00 },
  // Speaking: the sine is all but switched off and the voice does the moving.
  speaking:      { yaw:  0.16, breath: 0.003, breathHz: 0.70, ripple: 0.046, scale: 1.00, dot: 0.96, glow: 0.78, drive: 0.125 },
};

/**
 * How fast the live energy term rises and falls, in units of `1 - e^(-k·dt)`.
 *
 * Asymmetric, and that asymmetry is the whole character of the motion. A word
 * has to land almost instantly or the orb lags visibly behind the audio and
 * looks dubbed; the fall has to be slower or consecutive words strobe. These
 * are roughly a syllable's attack and a word's decay.
 */
const DRIVE_ATTACK = 34;
const DRIVE_RELEASE = 9;

// ── Palette ──────────────────────────────────────────────────────────────────
// Matches the app's existing voice language: a cool silver shell that reads as
// structure, with violet spent only where there is energy — the crest of a
// ripple, the core while the orb is active. Colour means "this is what the
// voice is doing", never decoration.
const DOT_HUE = "248 20%";
const HOT = "276 92%";
const CORE = "266 90%";

/** Depth quantisation. More buckets = smoother falloff, more draw calls. */
const DOT_BUCKETS = 7;
const HOT_BUCKETS = 3;
/** Below this share of a ripple's peak a point is drawn plain — no halo. Set
 *  high on purpose: only the crests should light, or it becomes violet fog. */
const HOT_FLOOR = 0.55;

interface Shell {
  count: number;
  /** Rest positions, xyz interleaved, within the unit sphere. */
  base: Float32Array;
  /** Distance from centre at rest, 0..1 — the direction a ripple travels. */
  radius: Float32Array;
  /** Per-point phase, so ripples cross the shell instead of pulsing as one. */
  phase: Float32Array;
  /** Per-point size/alpha jitter, 0..1, fixed at build time. */
  grain: Float32Array;
}

function buildShell(count: number): Shell {
  const base = new Float32Array(count * 3);
  const radius = new Float32Array(count);
  const phase = new Float32Array(count);
  const grain = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Even coverage of the sphere: uniform in height, golden angle around.
    // Cell-centred (`2i+1` over `2·count`), so no point lands exactly on a pole.
    const y = 1 - (2 * i + 1) / count;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * GOLDEN_ANGLE;

    // Cube root keeps density even per unit volume, so the shell doesn't turn
    // into a bright rim with a hollow middle once it is projected flat.
    const u = (i * RADIUS_STEP) % 1;
    const r = CORE_RADIUS + (1 - CORE_RADIUS) * Math.cbrt(u);

    base[i * 3] = Math.cos(theta) * ring * r;
    base[i * 3 + 1] = y * r;
    base[i * 3 + 2] = Math.sin(theta) * ring * r;
    radius[i] = r;
    phase[i] = (i * GOLDEN_ANGLE) % (Math.PI * 2);
    grain[i] = ((i * 0.6180339887) % 1);
  }

  return { count, base, radius, phase, grain };
}

/** Point count for the space available. A thousand dots on a phone is mush. */
function densityFor(cssWidth: number): number {
  if (cssWidth < 340) return 380;
  if (cssWidth < 520) return 620;
  return 900;
}

export function VoiceOrb({ state, getLevel, getSpeechPulse, className }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Live values are read through refs so the render loop is set up exactly once
  // and never torn down by a caller passing a fresh callback identity.
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(getLevel);
  levelRef.current = getLevel;
  const pulseRef = useRef(getSpeechPulse);
  pulseRef.current = getSpeechPulse;

  const reduceRef = useRef(false);
  const drawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    reduceRef.current = reduce;

    let shell = buildShell(620);
    // Scratch buffers, sized with the shell and reused every frame.
    let sx = new Float32Array(shell.count);
    let sy = new Float32Array(shell.count);
    let depth = new Float32Array(shell.count); // 0 = far, 1 = near
    let energy = new Float32Array(shell.count); // ripple crest, normalised
    let bucket = new Uint8Array(shell.count);

    const fitBuffers = () => {
      sx = new Float32Array(shell.count);
      sy = new Float32Array(shell.count);
      depth = new Float32Array(shell.count);
      energy = new Float32Array(shell.count);
      bucket = new Uint8Array(shell.count);
    };

    let cssW = 0;
    let cssH = 0;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    /** The breath's own clock. Advanced by the eased rate rather than read from
     *  `t`, so a rate change bends the cycle instead of jumping its phase. */
    let breathPhase = 0;

    // Eased animation state — every one of these chases its per-state target.
    let yawVel = STATE_TUNING.idle.yaw;
    let yaw = 0;
    let breath = STATE_TUNING.idle.breath;
    let breathHz = STATE_TUNING.idle.breathHz;
    let ripple = STATE_TUNING.idle.ripple;
    let scale = STATE_TUNING.idle.scale;
    let dotAlpha = STATE_TUNING.idle.dot;
    let glow = STATE_TUNING.idle.glow;
    let drive = STATE_TUNING.idle.drive;
    /** Instantaneous swell from the mic / spoken word, on top of the breath. */
    let live = 0;

    // Pointer parallax, eased back to rest whenever the pointer leaves.
    let pointerX = 0;
    let pointerY = 0;
    let parallaxX = 0;
    let parallaxY = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const n = densityFor(cssW);
      if (n !== shell.count) {
        shell = buildShell(n);
        fitBuffers();
      }
      if (reduce) drawRef.current?.();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (reduce) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointerX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    };
    const onPointerLeave = () => {
      pointerX = 0;
      pointerY = 0;
    };

    /** Advance the eased parameters by `dt` seconds toward the active state. */
    const step = (dt: number) => {
      const active = stateRef.current;
      const tuning = STATE_TUNING[active];

      // The live half of the motion: the mic while the user holds the turn,
      // spoken-word energy while the assistant holds it.
      let target = 0;
      if (active === "listening") {
        target = Math.min(1, Math.max(0, levelRef.current()));
      } else if (active === "speaking") {
        target = Math.min(1, Math.max(0, pulseRef.current?.() ?? 0));
      }

      // Rate-based easing: `1 - e^(-k·dt)` keeps the feel identical whether the
      // display runs at 60 Hz or 144 Hz.
      const ease = (rate: number) => 1 - Math.exp(-rate * dt);
      const slow = ease(3.2);
      const quick = ease(9);

      yawVel += (tuning.yaw - yawVel) * slow;
      breath += (tuning.breath - breath) * slow;
      breathHz += (tuning.breathHz - breathHz) * slow;
      ripple += (tuning.ripple - ripple) * quick;
      scale += (tuning.scale - scale) * slow;
      dotAlpha += (tuning.dot - dotAlpha) * slow;
      glow += (tuning.glow - glow) * slow;
      // Drive follows the state on the quick clock: it is the coupling between
      // the voice and the shell, and easing it in slowly meant the first second
      // of every reply played at a fraction of its intended motion — the orb
      // looked like it started talking late.
      drive += (tuning.drive - drive) * quick;
      // Attack near-instant, release slower: a word must land with the audio,
      // then ebb before the next one so the two read as separate syllables.
      live += (target - live) * ease(target > live ? DRIVE_ATTACK : DRIVE_RELEASE);
      parallaxX += (pointerX * 0.14 - parallaxX) * slow;
      parallaxY += (pointerY * 0.1 - parallaxY) * slow;

      yaw += yawVel * dt;
      if (yaw > Math.PI * 2) yaw -= Math.PI * 2;
      else if (yaw < 0) yaw += Math.PI * 2;
      breathPhase += breathHz * Math.PI * 2 * dt;
      if (breathPhase > Math.PI * 2) breathPhase -= Math.PI * 2;
      t += dt;
    };

    /** Jump straight to the active state's look, with no easing in between —
     *  the only way a still frame can show which state it is depicting. */
    const snapToState = () => {
      const tuning = STATE_TUNING[stateRef.current];
      yawVel = tuning.yaw;
      breath = tuning.breath;
      breathHz = tuning.breathHz;
      ripple = tuning.ripple;
      scale = tuning.scale;
      dotAlpha = tuning.dot;
      glow = tuning.glow;
      drive = tuning.drive;
      live = 0;
    };

    const draw = () => {
      const w = cssW;
      const h = cssH;
      if (w <= 0 || h <= 0) return;

      const cx = w / 2;
      const cy = h / 2;
      // Half-extent in pixels. The 0.38 is headroom, not taste: at full swell
      // (deepest breath + loudest input + a ripple crest + pointer parallax) a
      // point reaches ~2.34x this, and canvas clips its own bounds — so a larger
      // factor shaves dots off the silhouette exactly when the orb is liveliest.
      const unit = Math.min(w, h) * 0.38 * scale;
      const dotSize = Math.min(2.9, Math.max(1.05, unit * 0.0135));

      // ── The breath ─────────────────────────────────────────────────────────
      // During speech, 0.5 is neutral: each word carries the shell through a
      // real contraction and expansion. Other states retain their positive
      // input swell, since mic loudness has no useful negative half.
      const voiceBreath = stateRef.current === "speaking"
        ? (live * 2 - 1) * drive
        : live * drive;
      const swell = 1 + Math.sin(breathPhase) * breath + voiceBreath;

      const cosY = Math.cos(yaw + parallaxX);
      const sinY = Math.sin(yaw + parallaxX);
      const pitch = TILT + parallaxY;
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const { base, radius, phase, grain, count } = shell;
      // Bloom follows how much the shell is actually moving, so a resting orb
      // stays monochrome and violet only arrives when there is something to say.
      const bloom = smoothstep(0.014, 0.05, ripple) * (0.45 + 0.55 * live);

      ctx.clearRect(0, 0, w, h);

      // ── Core ───────────────────────────────────────────────────────────────
      // Drawn under the points: a soft centre that the shell reads as sitting
      // around, and the one element that answers loudness instantly.
      const coreAlpha = glow * (0.42 + 0.58 * live);
      if (coreAlpha > 0.01) {
        const coreR = unit * (0.92 + live * 0.16) * swell;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
        grad.addColorStop(0, `hsla(${CORE} 72% / ${(coreAlpha * 0.5).toFixed(3)})`);
        grad.addColorStop(0.42, `hsla(${CORE} 62% / ${(coreAlpha * 0.16).toFixed(3)})`);
        grad.addColorStop(1, `hsla(${CORE} 55% / 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Project ────────────────────────────────────────────────────────────
      for (let p = 0; p < count; p++) {
        const bx = base[p * 3];
        const by = base[p * 3 + 1];
        const bz = base[p * 3 + 2];
        const r0 = radius[p];
        const ph = phase[p];

        // A ripple travelling outward through the shell. Keyed on rest radius,
        // so it reads as something moving through the sphere rather than the
        // whole surface wobbling in place.
        const wave = Math.sin(t * 2.1 - r0 * 5.4 + ph);
        const crest = wave * 0.5 + 0.5;
        const push = ripple * (0.35 + 0.65 * crest) * (0.5 + 0.5 * live);
        energy[p] = crest;

        // Radial displacement, then breath: both act along the point's own
        // direction from the centre, which is what makes it read as a sphere
        // inflating rather than a sprite being scaled.
        const k = (1 + push / Math.max(r0, 0.001)) * swell;
        const px = bx * k;
        const py = by * k;
        const pz = bz * k;

        // Yaw about the vertical axis, then pitch the camera down onto it.
        // Orthographic from here: no perspective divide, so the silhouette
        // stays a true circle at every angle.
        const x1 = px * cosY + pz * sinY;
        const z1 = pz * cosY - px * sinY;
        const y2 = py * cosP - z1 * sinP;
        const z2 = py * sinP + z1 * cosP;

        sx[p] = cx + x1 * unit;
        sy[p] = cy - y2 * unit;

        const d = Math.min(1, Math.max(0, (z2 + 1.25) / 2.5));
        depth[p] = d;
        bucket[p] = Math.min(DOT_BUCKETS - 1, (d * DOT_BUCKETS) | 0);
      }

      // ── Points, batched by depth ───────────────────────────────────────────
      for (let b = 0; b < DOT_BUCKETS; b++) {
        const d = (b + 0.5) / DOT_BUCKETS;
        // The back of the sphere sits behind the core glow, so it is dimmed
        // hard: that contrast is the entire depth cue in an orthographic view.
        const a = dotAlpha * (0.16 + 0.84 * d * d);
        ctx.fillStyle = `hsla(${DOT_HUE} ${66 + b * 4}% / ${a.toFixed(3)})`;
        ctx.beginPath();
        for (let p = 0; p < count; p++) {
          if (bucket[p] !== b) continue;
          // Grain keeps the field from looking printed — a little variation in
          // size per point, fixed at build time so it never shimmers.
          const r = dotSize * (0.62 + 0.5 * d + 0.34 * grain[p]);
          ctx.moveTo(sx[p] + r, sy[p]);
          ctx.arc(sx[p], sy[p], r, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // ── Energy pass: violet bloom on the crests of the ripple ──────────────
      // Additive halos rather than shadowBlur — same glow, a fraction of the
      // cost, and it stays crisp when hundreds of points light up at once.
      if (bloom > 0.01) {
        ctx.globalCompositeOperation = "lighter";
        for (let b = 0; b < HOT_BUCKETS; b++) {
          const lo = HOT_FLOOR + ((1 - HOT_FLOOR) * b) / HOT_BUCKETS;
          // The top bucket reaches past 1 so a point at full energy is included.
          const hi =
            b === HOT_BUCKETS - 1 ? Infinity : HOT_FLOOR + ((1 - HOT_FLOOR) * (b + 1)) / HOT_BUCKETS;
          const strength = (b + 1) / HOT_BUCKETS;
          const a = (0.02 + strength * 0.075) * bloom;
          ctx.fillStyle = `hsla(${HOT} ${64 + b * 6}% / ${a.toFixed(3)})`;
          ctx.beginPath();
          let drew = false;
          for (let p = 0; p < count; p++) {
            const en = energy[p];
            if (en < lo || en >= hi) continue;
            const r = dotSize * (1.4 + 2.0 * strength) * (0.4 + depth[p] * 0.9);
            ctx.moveTo(sx[p] + r, sy[p]);
            ctx.arc(sx[p], sy[p], r, 0, Math.PI * 2);
            drew = true;
          }
          if (drew) ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }
    };

    const paintStatic = () => {
      snapToState();
      draw();
    };
    drawRef.current = reduce ? paintStatic : draw;

    const tick = (now: number) => {
      // Clamped so a backgrounded tab doesn't resume with one giant leap.
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      step(dt);
      draw();
      raf = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (raf || reduce) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };
    // Nothing to animate behind another tab — don't burn the battery.
    const onVisibility = () => (document.hidden ? stopLoop() : startLoop());

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    if (reduce) {
      paintStatic(); // one considered still frame: the shape, none of the motion
    } else {
      startLoop();
    }

    return () => {
      stopLoop();
      drawRef.current = null;
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  // With motion reduced there is no loop to pick the change up, so a state
  // change has to repaint the still frame itself.
  useEffect(() => {
    if (reduceRef.current) drawRef.current?.();
  }, [state]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
