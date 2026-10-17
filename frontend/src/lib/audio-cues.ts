/**
 * Short UI sound cues, synthesised with the Web Audio API.
 *
 * Nothing is downloaded: a hang-up blip is two sine tones and an envelope,
 * which is a few lines of oscillator code and zero bytes of asset — the same
 * reason the rest of the voice stack avoids hosted services.
 *
 * One AudioContext is shared and kept alive for the tab. Browsers start it
 * suspended until a user gesture, and every cue here fires from a click, so a
 * resume() on play is enough; a cue that can't play is silently dropped
 * because a missing sound must never break the action it decorates.
 */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx && ctx.state !== "closed") return ctx;
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

interface ToneSpec {
  /** Hz. */
  freq: number;
  /** Seconds from the start of the cue. */
  at: number;
  /** Seconds. */
  dur: number;
  /** Peak gain, 0..1. */
  peak: number;
}

/**
 * Plays a sequence of enveloped sine tones.
 *
 * The envelope matters more than the pitches: a bare gain switch produces an
 * audible click at both ends (an instantaneous jump in the waveform is
 * broadband noise). So each tone ramps up over a few ms and decays
 * exponentially — exponential ramps cannot reach zero, hence the tiny floor
 * followed by a hard stop.
 */
function playTones(tones: ToneSpec[]): void {
  const ac = audioCtx();
  if (!ac) return;
  // Autoplay policy parks the context until a gesture; resume is a no-op when
  // it is already running.
  if (ac.state === "suspended") void ac.resume().catch(() => {});

  const t0 = ac.currentTime + 0.01;
  for (const tone of tones) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(tone.freq, t0 + tone.at);

    const start = t0 + tone.at;
    const end = start + tone.dur;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(tone.peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(end + 0.02);
    // Nodes are one-shot; dropping the references lets them be collected.
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }
}

/**
 * Call-ended blip: two descending tones, the near-universal "hung up" idiom
 * (rising = connected, falling = disconnected). Kept quiet and under 300 ms —
 * it confirms the call ended, it doesn't announce it.
 */
export function playCallEnd(): void {
  playTones([
    { freq: 660, at: 0, dur: 0.11, peak: 0.13 },
    { freq: 440, at: 0.1, dur: 0.17, peak: 0.11 },
  ]);
}

/** Warms the audio context from an existing user gesture, so the first cue of
 *  the session isn't swallowed by the autoplay policy. */
export function unlockCues(): void {
  const ac = audioCtx();
  if (ac?.state === "suspended") void ac.resume().catch(() => {});
}
