/**
 * Lottie "listening" equaliser — five bars bouncing out of phase, in the
 * recording-red palette. Built programmatically so the five near-identical
 * layers stay in sync and the loop is seamless (sine sampled over one period).
 */
const ease = { i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } };

const FRAMES = 60; // 2s at 30fps
const BAR_W = 7;
const BAR_H = 26;
const RED: [number, number, number, number] = [0.96, 0.38, 0.42, 1];

function barScaleKeyframes(phase: number) {
  const kf: Array<Record<string, unknown>> = [];
  for (let f = 0; f <= FRAMES; f += 5) {
    const v = Math.round(40 + 75 * (0.5 + 0.5 * Math.sin((f / FRAMES) * Math.PI * 2 + phase)));
    const k: Record<string, unknown> = { t: f, s: [100, v] };
    if (f < FRAMES) Object.assign(k, ease); // terminal keyframe needs no easing
    kf.push(k);
  }
  return kf;
}

function bar(ind: number, x: number, phase: number) {
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm: `bar${ind}`,
    sr: 1,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: { a: 0, k: [x, 30, 0] },
      a: { a: 0, k: [0, 0, 0] },
      s: { a: 1, k: barScaleKeyframes(phase) },
    },
    shapes: [
      {
        ty: "gr",
        it: [
          { ty: "rc", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [BAR_W, BAR_H] }, r: { a: 0, k: BAR_W / 2 } },
          { ty: "fl", c: { a: 0, k: RED }, o: { a: 0, k: 100 } },
          { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ],
      },
    ],
    ip: 0,
    op: FRAMES,
    st: 0,
    bm: 0,
  };
}

const XS = [16, 33, 50, 67, 84];
const PHASES = [0, 1.1, 2.0, 1.1, 0];

export const listeningWave: object = {
  v: "5.7.4",
  fr: 30,
  ip: 0,
  op: FRAMES,
  w: 100,
  h: 60,
  nm: "listening",
  ddd: 0,
  assets: [],
  layers: XS.map((x, i) => bar(i + 1, x, PHASES[i])),
};
