// Exercises the real src/lib/prosody.ts: the autocorrelation pitch tracker and
// the contour judgement that tells the endpointer whether a speaker's voice was
// landing or still climbing.
//
// Pitch detection is tested against synthesised glottal-like tones rather than
// recorded speech, because the property that matters is arithmetic: given a
// waveform with a known fundamental, does it report that fundamental, and given
// a sequence of them, does it read the trend in the right direction.
import {
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  PROSODY_FALL_SEMITONES,
  PROSODY_MIN_FRAMES,
  PROSODY_RISE_SEMITONES,
  PROSODY_WINDOW_FRAMES,
  createProsodyState,
  estimatePitch,
  judgeProsody,
  observeFrame,
  resetProsody,
  semitones,
} from "./prosody.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

const RATE = 16000;
const FRAME = 512; // what Silero v5 hands us

/**
 * A frame of voiced-sounding audio at `hz`.
 *
 * A pure sine is a poor stand-in for a voice: it has a single spectral peak, so
 * an autocorrelator can lock onto it in ways it never could with speech. Adding
 * harmonics at decaying amplitude gives the sawtooth-ish shape a glottal pulse
 * actually has, which is the signal the tracker has to cope with in the field.
 */
const voiced = (hz, { length = FRAME, harmonics = 5, noise = 0, phase = 0 } = {}) => {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      v += Math.sin(2 * Math.PI * hz * h * (i / RATE) + phase) / h;
    }
    out[i] = v * 0.3 + (noise ? (Math.random() * 2 - 1) * noise : 0);
  }
  return out;
};

/** Deterministic pseudo-noise, so an "unvoiced" test cannot flake. */
const hiss = (length = FRAME) => {
  const out = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x3fffffff - 1) * 0.2;
  }
  return out;
};

// ── estimatePitch ──────────────────────────────────────────────────────────
for (const hz of [90, 120, 150, 200, 260, 320]) {
  const got = estimatePitch(voiced(hz), RATE);
  const err = Math.abs(got - hz) / hz;
  check(`estimatePitch tracks ${hz} Hz`, err < 0.06, `got ${got.toFixed(1)} Hz`);
}

check("estimatePitch returns 0 for digital silence", estimatePitch(new Float32Array(FRAME), RATE) === 0);
check("estimatePitch returns 0 for an empty frame", estimatePitch(new Float32Array(0), RATE) === 0);
check("estimatePitch returns 0 for a too-short frame", estimatePitch(voiced(150, { length: 32 }), RATE) === 0);
check("estimatePitch returns 0 at a nonsense sample rate", estimatePitch(voiced(150), 0) === 0);
check("estimatePitch rejects unvoiced hiss", estimatePitch(hiss(), RATE) === 0, `got ${estimatePitch(hiss(), RATE)}`);

// A DC offset is what a cheap microphone adds; it must not be read as periodicity.
{
  const frame = voiced(150);
  const offset = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) offset[i] = frame[i] + 0.5;
  const got = estimatePitch(offset, RATE);
  check("estimatePitch survives a DC offset", Math.abs(got - 150) / 150 < 0.06, `got ${got.toFixed(1)} Hz`);
}

// Octave errors invert the very trend we are reading, so the guard matters.
{
  const got = estimatePitch(voiced(100, { harmonics: 8 }), RATE);
  check(
    "estimatePitch does not halve to the sub-octave",
    got > 90 && got < 112,
    `got ${got.toFixed(1)} Hz (a 2x error would read ~50)`,
  );
}

// Anything it does report must be inside the band it claims to search.
{
  let outOfBand = 0;
  for (const hz of [80, 110, 145, 190, 240, 300, 340]) {
    const got = estimatePitch(voiced(hz, { noise: 0.05 }), RATE);
    if (got !== 0 && (got < PITCH_MIN_HZ || got > PITCH_MAX_HZ)) outOfBand++;
  }
  check("estimatePitch never reports outside [PITCH_MIN_HZ, PITCH_MAX_HZ]", outOfBand === 0);
}

// ── semitones ──────────────────────────────────────────────────────────────
check("semitones: an octave up is +12", Math.abs(semitones(100, 200) - 12) < 1e-9);
check("semitones: an octave down is -12", Math.abs(semitones(200, 100) + 12) < 1e-9);
check("semitones: no change is 0", semitones(150, 150) === 0);
check("semitones: guards zero and negative input", semitones(0, 150) === 0 && semitones(150, 0) === 0);

// ── observeFrame / state ───────────────────────────────────────────────────
{
  const state = createProsodyState();
  observeFrame(state, hiss(), RATE);
  check("observeFrame records nothing for an unvoiced frame", state.pitches.length === 0);

  observeFrame(state, voiced(150), RATE);
  check("observeFrame records a voiced frame", state.pitches.length === 1);

  resetProsody(state);
  check("resetProsody empties the contour", state.pitches.length === 0);
}

{
  const state = createProsodyState();
  for (let i = 0; i < PROSODY_WINDOW_FRAMES * 3; i++) observeFrame(state, voiced(150), RATE);
  check(
    "observeFrame bounds the window",
    state.pitches.length === PROSODY_WINDOW_FRAMES,
    `kept ${state.pitches.length}`,
  );
}

// ── judgeProsody ───────────────────────────────────────────────────────────
/** Feed a pitch ramp from `from` to `to` across `frames` voiced frames. */
const contour = (from, to, frames = PROSODY_WINDOW_FRAMES) => {
  const state = createProsodyState();
  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? 0 : i / (frames - 1);
    observeFrame(state, voiced(from + (to - from) * t), RATE);
  }
  return judgeProsody(state);
};

check("judgeProsody: empty state is unknown", judgeProsody(createProsodyState()) === "unknown");

{
  const state = createProsodyState();
  for (let i = 0; i < PROSODY_MIN_FRAMES - 1; i++) observeFrame(state, voiced(150), RATE);
  check("judgeProsody: too few voiced frames is unknown", judgeProsody(state) === "unknown");
}

check("judgeProsody: a steady voice is level", contour(150, 150) === "level", contour(150, 150));
check("judgeProsody: 200→130 Hz is falling", contour(200, 130) === "falling", contour(200, 130));
check("judgeProsody: 130→200 Hz is rising", contour(130, 200) === "rising", contour(130, 200));

// A statement-final fall is a big move; a hesitation wobble is not. The gap
// between those two is the whole reason this is worth doing.
check("judgeProsody: a 1-semitone wobble stays level", contour(150, 159) === "level", contour(150, 159));
check("judgeProsody: a 5-semitone drop is falling", contour(200, 150) === "falling", contour(200, 150));

// Declination: pitch sags across any utterance, finished or not, and over a
// window this long the sag alone is worth a semitone or two. Reading that as a
// terminal fall would cut people off mid-sentence, so it must not.
check(
  "judgeProsody: a 2-semitone declination sag is not a terminal fall",
  contour(160, 143) === "level",
  contour(160, 143),
);
// Calibration, stated as behaviour rather than as a magic number: the whole
// declination band must read level, and the whole terminal-fall band must read
// falling, with nothing ambiguous in between. Sentence-final falls are 3–7
// semitones; declination over a window this short is 1–2.
{
  const declination = [1, 1.5, 2].map((st) => contour(160, 160 * 2 ** (-st / 12)));
  const terminal = [3, 4, 5, 6, 7].map((st) => contour(200, 200 * 2 ** (-st / 12)));
  check(
    "the whole declination band reads level",
    declination.every((c) => c === "level"),
    declination.join(","),
  );
  check(
    "the whole terminal-fall band reads falling",
    terminal.every((c) => c === "falling"),
    terminal.join(","),
  );
}
// Asymmetric on purpose: declination pushes measurements downward, so a rise
// has to fight it and is the more trustworthy reading of the two.
check(
  "the rise threshold is the more sensitive one",
  PROSODY_RISE_SEMITONES < PROSODY_FALL_SEMITONES,
  `rise ${PROSODY_RISE_SEMITONES} vs fall ${PROSODY_FALL_SEMITONES}`,
);

// The window only keeps the most recent frames, so a fall that happened long
// before the pause must not still be reported at the pause. This is what makes
// per-segment reset safe.
{
  const state = createProsodyState();
  for (let i = 0; i < PROSODY_WINDOW_FRAMES; i++) observeFrame(state, voiced(220), RATE);
  for (let i = 0; i < PROSODY_WINDOW_FRAMES; i++) observeFrame(state, voiced(140), RATE);
  check(
    "judgeProsody reads only the recent window, not the whole utterance",
    judgeProsody(state) === "level",
    judgeProsody(state),
  );
}

console.log(failed === 0 ? "\nAll prosody checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
