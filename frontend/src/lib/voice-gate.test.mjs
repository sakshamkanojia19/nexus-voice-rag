// Exercises the real src/lib/voice-gate.ts: the adaptive noise floor and the
// loudness gate that decides whether a Silero speech segment was actually
// someone addressing the app, or just the room being a room.
import {
  MIN_SNR,
  MIN_UTTERANCE_RMS,
  NOISE_FLOOR_INIT,
  NOISE_FLOOR_MIN,
  frameRms,
  judgeLoudness,
  updateNoiseFloor,
} from "./voice-gate.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

/** Settle the floor at some ambient level, the way a real room would. */
const settle = (rms, frames = 400, from = NOISE_FLOOR_INIT) => {
  let floor = from;
  for (let i = 0; i < frames; i++) floor = updateNoiseFloor(floor, rms);
  return floor;
};

// ── frameRms ───────────────────────────────────────────────────────────────
check("frameRms of silence is 0", frameRms(new Float32Array(512)) === 0);
check("frameRms of an empty frame is 0", frameRms(new Float32Array(0)) === 0);
check(
  "frameRms of full-scale DC is 1",
  Math.abs(frameRms(new Float32Array(512).fill(1)) - 1) < 1e-9,
);
check(
  "frameRms of ±0.5 square wave is 0.5",
  Math.abs(frameRms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9,
);

// ── Noise floor tracking ───────────────────────────────────────────────────
check(
  "floor converges up to a steady ambient level",
  Math.abs(settle(0.02) - 0.02) < 1e-3,
  `got ${settle(0.02)}`,
);
check(
  "floor converges back down when the room goes quiet",
  settle(0.001, 400, settle(0.05)) < 0.002,
);
check(
  "floor rises slower than it falls (a burst must not desensitise the mic)",
  updateNoiseFloor(0.01, 0.05) - 0.01 < 0.01 - updateNoiseFloor(0.01, 0.0),
);
{
  // A door slamming is a handful of loud non-speech frames. The floor must
  // absorb them without desensitising the microphone for the sentence that
  // follows — that asymmetry is the whole reason rise ≠ fall.
  const quiet = settle(0.004);
  let floor = quiet;
  for (let i = 0; i < 3; i++) floor = updateNoiseFloor(floor, 0.5); // ~100ms slam
  check(
    "speech immediately after a loud burst still passes the gate",
    judgeLoudness(0.08, floor).accepted,
    `floor rose to ${floor.toFixed(4)}`,
  );
  // ~640ms of ordinary room tone afterwards (20 frames of 32ms).
  for (let i = 0; i < 20; i++) floor = updateNoiseFloor(floor, 0.004);
  check(
    "the floor recovers to within 1.5x ambient ~640ms after the burst",
    floor < quiet * 1.5,
    `floor ${floor.toFixed(4)} vs ambient ${quiet.toFixed(4)}`,
  );
  // Repeated bursts must not ratchet the floor upward past normal speech.
  let ratchet = quiet;
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 3; i++) ratchet = updateNoiseFloor(ratchet, 0.5);
    for (let i = 0; i < 30; i++) ratchet = updateNoiseFloor(ratchet, 0.004);
  }
  check(
    "repeated bursts do not ratchet the floor above speaking level",
    judgeLoudness(0.08, ratchet).accepted,
    `floor ratcheted to ${ratchet.toFixed(4)}`,
  );
}

// ── The gate ───────────────────────────────────────────────────────────────
const quietRoom = settle(0.002);
const noisyRoom = settle(0.03); // open-plan office / fan / traffic

const cases = [
  // [label, peakRms, floor, shouldAccept]
  ["normal speech, quiet room", 0.09, quietRoom, true],
  ["quiet speech, quiet room", 0.05, quietRoom, true],
  ["loud speech, noisy room", 0.22, noisyRoom, true],
  ["speech at exactly the absolute minimum", MIN_UTTERANCE_RMS, quietRoom, true],

  ["near-silence in a quiet room", 0.004, quietRoom, false],
  ["room tone only", 0.002, quietRoom, false],
  ["a segment that never rose above ambient", 0.03, noisyRoom, false],
  ["ambient-level audio in a noisy room", 0.05, noisyRoom, false],
  // The case the absolute floor exists for: in a near-silent room the SNR ratio
  // alone would happily admit inaudible noise.
  ["inaudible noise in a near-silent room", 0.012, 1e-6, false],
];

for (const [label, peak, floor, shouldAccept] of cases) {
  const verdict = judgeLoudness(peak, floor);
  check(
    `${shouldAccept ? "accept" : "reject"}  ${label}`,
    verdict.accepted === shouldAccept,
    verdict.accepted ? "accepted" : `rejected (${verdict.reason})`,
  );
}

// ── Invariants ─────────────────────────────────────────────────────────────
check(
  "the floor is clamped, so a zero floor cannot admit anything below the absolute minimum",
  !judgeLoudness(MIN_UTTERANCE_RMS - 1e-6, 0).accepted,
);
check(
  "acceptance is monotonic in loudness",
  Array.from({ length: 200 }, (_, i) => i / 1000)
    .map((peak) => judgeLoudness(peak, quietRoom).accepted)
    .every((accepted, i, all) => i === 0 || accepted >= all[i - 1]),
);
check(
  "a louder room never makes a fixed utterance easier to accept",
  Array.from({ length: 100 }, (_, i) => NOISE_FLOOR_MIN + i / 2000)
    .map((floor) => judgeLoudness(0.06, floor).accepted)
    .every((accepted, i, all) => i === 0 || accepted <= all[i - 1]),
);
check(
  "rejection reasons are distinguishable",
  judgeLoudness(0.001, quietRoom).reason === "too-quiet" &&
    judgeLoudness(0.05, noisyRoom).reason === "low-snr",
);
check(
  "MIN_SNR is actually applied against the clamped floor",
  !judgeLoudness(NOISE_FLOOR_MIN * MIN_SNR - 1e-6, 0).accepted,
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
