/**
 * Loudness gating for the live voice call.
 *
 * Silero answers "is this speech?". That is not the same question as "is this
 * someone talking to this app?" — a TV two rooms away, a colleague across the
 * office and a podcast on a neighbouring desk are all genuinely speech, and a
 * model trained to detect speech will happily detect them. What separates them
 * from the user is level: the user is close to the microphone and everything
 * else is not.
 *
 * So we track the room's own noise level and require an utterance to stand out
 * from it. Two independent conditions, because each catches what the other
 * misses: an absolute floor rejects quiet audio in a silent room (where a ratio
 * against near-zero ambient would pass anything), and a signal-to-noise ratio
 * rejects audio that is loud only because the whole room is loud.
 *
 * Pure and dependency-free so the rules can be exercised directly.
 */

/** Starting floor before any ambient audio has been measured. */
export const NOISE_FLOOR_INIT = 0.005;
/**
 * Floor tracking is deliberately asymmetric. Rising slowly means a burst of
 * noise — a door, a cough, a passing truck — cannot desensitise the microphone
 * for the sentence that follows it. Falling quickly means the gate re-arms
 * promptly once a noisy room goes quiet.
 */
export const NOISE_FLOOR_RISE = 0.02;
export const NOISE_FLOOR_FALL = 0.15;
/** Ambient never tracks below this, so a silent room can't make the ratio
 *  explode and admit inaudible noise. */
export const NOISE_FLOOR_MIN = 0.003;
/** An utterance's loudest frame must beat ambient by this factor. */
export const MIN_SNR = 2.4;
/** …and must clear this absolute RMS however quiet the room is. */
export const MIN_UTTERANCE_RMS = 0.014;

/** Root-mean-square amplitude of one mono frame of samples in -1..1. */
export function frameRms(frame: Float32Array | number[]): number {
  const length = frame.length;
  if (length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / length);
}

/**
 * Fold one non-speech frame into the running ambient estimate. Callers must only
 * pass frames the VAD is confident are NOT speech — feeding speech into the
 * floor would teach the gate to ignore the user.
 */
export function updateNoiseFloor(floor: number, rms: number): number {
  const alpha = rms > floor ? NOISE_FLOOR_RISE : NOISE_FLOOR_FALL;
  return floor * (1 - alpha) + rms * alpha;
}

export type GateVerdict =
  | { accepted: true }
  | { accepted: false; reason: "too-quiet" | "low-snr"; detail: string };

/**
 * Decide whether a completed speech segment was someone addressing the app.
 * `peakRms` is the loudest frame observed between speech-start and speech-end.
 */
export function judgeLoudness(peakRms: number, noiseFloor: number): GateVerdict {
  const floor = Math.max(noiseFloor, NOISE_FLOOR_MIN);
  if (peakRms < MIN_UTTERANCE_RMS) {
    return {
      accepted: false,
      reason: "too-quiet",
      detail: `peak ${peakRms.toFixed(4)} < ${MIN_UTTERANCE_RMS}`,
    };
  }
  if (peakRms < floor * MIN_SNR) {
    return {
      accepted: false,
      reason: "low-snr",
      detail: `peak ${peakRms.toFixed(4)} vs floor ${floor.toFixed(4)}, need ${MIN_SNR}x`,
    };
  }
  return { accepted: true };
}
