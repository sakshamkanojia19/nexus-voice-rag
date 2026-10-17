/**
 * Hearing *how* something was said, not just what was said.
 *
 * `endpointing.ts` decides when a turn is over by reading the transcript. That
 * works well when the words are decisive — "…the capital of" cannot be an
 * ending, "…of France?" obviously is — but most real utterances fall in the
 * gap between those, and the text rules return `unclear` for them. That bucket
 * is the single biggest source of both remaining failures: waiting too long
 * after someone has plainly finished, and cutting in while they are plainly
 * still going.
 *
 * A human listener does not resolve that from words. They resolve it from
 * intonation. English (and Hindi) speakers drop their pitch at the end of a
 * statement and hold it level or push it up when more is coming — the falling
 * terminal contour is the most reliable "I'm done" signal in speech, and it
 * arrives before the silence does. This module measures that contour from the
 * audio frames Silero is already handing us, so it costs one pass over samples
 * we have in hand and no new model, download, dependency or licence.
 *
 * It is deliberately only used to *nudge* the text decision, never to overrule
 * a confident one — see `judgeEndpoint`. A hand-rolled pitch tracker is a
 * weaker signal than a grammatical guarantee, and it should lose to one.
 *
 * Pure and dependency-free apart from an explicitly-passed state object, so the
 * behaviour can be exercised directly.
 */

// ── Tuning ──────────────────────────────────────────────────────────────────
/** Lowest F0 we look for. Below a typical adult male speaking floor. */
export const PITCH_MIN_HZ = 70;
/** Highest F0 we look for. Above a typical adult female speaking ceiling;
 *  going higher starts admitting formant peaks as if they were pitch. */
export const PITCH_MAX_HZ = 350;
/**
 * Normalised autocorrelation a frame must reach to count as voiced. Voiced
 * speech is strongly periodic and clears this comfortably; fricatives, breath
 * and room noise do not, and letting them through would fill the contour with
 * meaningless numbers.
 */
export const VOICING_THRESHOLD = 0.4;
/**
 * A peak this close in strength to the best one, at half the lag, is taken
 * instead. Autocorrelation is just as happy locking onto two periods as one,
 * and an octave error inverts the very trend we are trying to read.
 */
export const OCTAVE_PREFERENCE = 0.85;

/** Voiced frames kept. At ~32 ms a frame this is roughly the last 0.8 s of
 *  voicing — the stretch a terminal contour actually lives in. */
export const PROSODY_WINDOW_FRAMES = 24;
/** Below this many voiced frames there is no contour to speak of, only noise. */
export const PROSODY_MIN_FRAMES = 6;
/**
 * Fraction of the window taken as the "start" and "end" anchors for the trend.
 *
 * Thirds rather than halves. Comparing the two halves of a ramp compares their
 * midpoints, which sit at the 25% and 75% marks — so it reports only half the
 * excursion actually present, and every threshold below would silently mean
 * twice what it says. Thirds span roughly two-thirds of the move, which is
 * close enough that the numbers can be reasoned about directly.
 */
export const PROSODY_EDGE_FRACTION = 1 / 3;
/**
 * Semitones of drop between those anchors that count as a falling terminal.
 *
 * Deliberately higher than the rise threshold, because of declination: pitch
 * drifts gradually downward across *any* utterance, finished or not, and over a
 * window this long that drift alone is worth one to two semitones — which
 * measures as well under 1.5 here. A threshold set low enough to catch every
 * genuine fall would therefore also fire mid-sentence, and the two failures are
 * not equally bad: a missed fall merely reverts to the previous, slower
 * behaviour, while a false one cuts the speaker off, which is the exact bug
 * this work exists to fix. Real sentence-final falls run 3–7 semitones, or
 * roughly 2–4.7 as measured here.
 */
export const PROSODY_FALL_SEMITONES = 2;
/**
 * …and of rise. Lower, for the same reason inverted: declination biases the
 * measurement downward, so a rise has to overcome it before it is visible at
 * all. Anything that still reads as rising is that much more trustworthy.
 */
export const PROSODY_RISE_SEMITONES = 1.5;

/** How the speaker's pitch moved over the final stretch of voicing. */
export type ProsodyContour = "falling" | "rising" | "level" | "unknown";

/**
 * Rolling pitch history for one speech segment.
 *
 * Mutated in place rather than returned fresh: this is fed from the VAD's
 * frame callback ~31 times a second, and allocating a new array per frame to
 * stay nominally pure would be waste with no benefit to the caller.
 */
export interface ProsodyState {
  /** F0 in Hz for recent voiced frames, oldest first. Unvoiced frames are
   *  simply not recorded — a gap in voicing is not a pitch of zero. */
  pitches: number[];
}

export function createProsodyState(): ProsodyState {
  return { pitches: [] };
}

export function resetProsody(state: ProsodyState): void {
  state.pitches.length = 0;
}

/**
 * Estimate the fundamental frequency of one frame, in Hz, or 0 if the frame is
 * not voiced.
 *
 * Normalised autocorrelation over a half-rate copy of the frame. Halving the
 * rate cuts the work by four and costs nothing that matters here: F0 tops out
 * at 350 Hz, two octaves below the reduced Nyquist, and we are reading a trend
 * rather than tuning an instrument.
 */
export function estimatePitch(frame: Float32Array | number[], sampleRate: number): number {
  const sourceLength = frame.length;
  if (sourceLength < 64 || sampleRate <= 0) return 0;

  // Decimate 2:1, averaging each pair. The average is a crude one-pole
  // anti-alias filter — enough to keep high-frequency energy from folding down
  // into the range we search.
  const n = sourceLength >> 1;
  const x = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = ((frame[2 * i] ?? 0) + (frame[2 * i + 1] ?? 0)) * 0.5;
    x[i] = v;
    mean += v;
  }
  mean /= n;

  // Remove DC. A microphone offset adds a constant to every lag's correlation
  // and would drag the normalised score toward 1 regardless of periodicity.
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = (x[i] ?? 0) - mean;
    x[i] = v;
    energy += v * v;
  }
  if (energy <= 1e-9) return 0; // digital silence

  const rate = sampleRate / 2;
  const minLag = Math.max(2, Math.floor(rate / PITCH_MAX_HZ));
  const maxLag = Math.min(n - 1, Math.ceil(rate / PITCH_MIN_HZ));
  if (maxLag <= minLag) return 0;

  let bestLag = 0;
  let bestScore = 0;
  const scores = new Float32Array(maxLag + 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let tailEnergy = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      const a = x[i] ?? 0;
      const b = x[i + lag] ?? 0;
      sum += a * b;
      tailEnergy += b * b;
    }
    // Normalising by the energy of *both* halves keeps the score in -1..1 even
    // as the overlap shrinks at long lags, which a plain r[lag]/r[0] does not.
    const norm = Math.sqrt(energy * tailEnergy);
    const score = norm > 1e-9 ? sum / norm : 0;
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || bestScore < VOICING_THRESHOLD) return 0;

  // Octave guard: if half this lag also correlates nearly as well, the real
  // period is the shorter one and we locked onto its second repetition.
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag && (scores[halfLag] ?? 0) >= bestScore * OCTAVE_PREFERENCE) {
    bestLag = halfLag;
  }

  // Parabolic interpolation through the neighbours of the peak. Lag is an
  // integer number of samples, which at 8 kHz quantises a 200 Hz voice into
  // steps of ~5 Hz — coarse enough to invent trends that are not there.
  const y0 = scores[bestLag - 1] ?? 0;
  const y1 = scores[bestLag] ?? 0;
  const y2 = scores[bestLag + 1] ?? 0;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const refined = bestLag + (Math.abs(shift) < 1 ? shift : 0);
  if (refined <= 0) return 0;

  const hz = rate / refined;
  return hz >= PITCH_MIN_HZ && hz <= PITCH_MAX_HZ ? hz : 0;
}

/**
 * Fold one frame of speech into the contour. Unvoiced frames are ignored, so
 * callers can pass every frame and let this decide what is usable.
 */
export function observeFrame(
  state: ProsodyState,
  frame: Float32Array | number[],
  sampleRate: number,
): void {
  const hz = estimatePitch(frame, sampleRate);
  if (hz <= 0) return;
  state.pitches.push(hz);
  if (state.pitches.length > PROSODY_WINDOW_FRAMES) state.pitches.shift();
}

/** Middle value of a list. Used rather than the mean because a single surviving
 *  octave error would drag an average several semitones on its own. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Interval between two frequencies in semitones; positive means `to` is higher. */
export function semitones(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return 12 * Math.log2(to / from);
}

/**
 * Which way the voice was heading as it fell silent.
 *
 * The first and last thirds of the window are compared by median, rather than
 * fitting a line through all of it: a least-squares slope over a contour with a
 * couple of surviving octave errors swings wildly, whereas a median barely
 * moves. The middle third is ignored on purpose — it carries the least
 * information about where the contour ended up.
 */
export function judgeProsody(state: ProsodyState): ProsodyContour {
  const pitches = state.pitches;
  if (pitches.length < PROSODY_MIN_FRAMES) return "unknown";

  // At the minimum window size a third rounds down to one frame; never zero,
  // or the median below would have nothing to work with.
  const edge = Math.max(1, Math.floor(pitches.length * PROSODY_EDGE_FRACTION));
  const head = median(pitches.slice(0, edge));
  const tail = median(pitches.slice(pitches.length - edge));
  if (head <= 0 || tail <= 0) return "unknown";

  const delta = semitones(head, tail);
  if (delta <= -PROSODY_FALL_SEMITONES) return "falling";
  if (delta >= PROSODY_RISE_SEMITONES) return "rising";
  return "level";
}
