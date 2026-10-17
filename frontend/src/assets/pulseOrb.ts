/**
 * Hand-authored Lottie animation: a "sonar pulse" orb — a soft core dot with
 * two staggered expanding rings, in the brand violet→magenta palette.
 * Exported as a typed object so it imports cleanly under strict TS (no
 * resolveJsonModule needed) and feeds straight into <Lottie animationData/>.
 */
const ease = { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] } };

export const pulseOrb: object = {
  v: "5.7.4",
  fr: 30,
  ip: 0,
  op: 90,
  w: 200,
  h: 200,
  nm: "pulse-orb",
  ddd: 0,
  assets: [],
  layers: [
    // Core dot — gentle breathing pulse.
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: "core",
      sr: 1,
      ks: {
        o: { a: 0, k: 92 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [100, 100, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [100, 100], ...ease },
            { t: 45, s: [120, 120], ...ease },
            { t: 90, s: [100, 100] },
          ],
        },
      },
      shapes: [
        {
          ty: "gr",
          it: [
            { ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [44, 44] }, d: 1 },
            { ty: "fl", c: { a: 0, k: [0.62, 0.4, 0.96, 1] }, o: { a: 0, k: 100 } },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip: 0,
      op: 90,
      st: 0,
      bm: 0,
    },
    // Ring 1 — expands across the full loop.
    {
      ddd: 0,
      ind: 2,
      ty: 4,
      nm: "ring1",
      sr: 1,
      ks: {
        o: {
          a: 1,
          k: [
            { t: 0, s: [70], ...ease },
            { t: 80, s: [0] },
            { t: 90, s: [0] },
          ],
        },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [100, 100, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [30, 30], ...ease },
            { t: 90, s: [175, 175] },
          ],
        },
      },
      shapes: [
        {
          ty: "gr",
          it: [
            { ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [60, 60] }, d: 1 },
            { ty: "st", c: { a: 0, k: [0.85, 0.35, 0.92, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 7 }, lc: 2, lj: 1, ml: 4 },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip: 0,
      op: 90,
      st: 0,
      bm: 0,
    },
    // Ring 2 — same wave, phase-shifted by half a loop.
    {
      ddd: 0,
      ind: 3,
      ty: 4,
      nm: "ring2",
      sr: 1,
      ks: {
        o: {
          a: 1,
          k: [
            { t: 0, s: [0], ...ease },
            { t: 45, s: [70], ...ease },
            { t: 90, s: [0] },
          ],
        },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [100, 100, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [30, 30], ...ease },
            { t: 45, s: [30, 30], ...ease },
            { t: 90, s: [175, 175] },
          ],
        },
      },
      shapes: [
        {
          ty: "gr",
          it: [
            { ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [60, 60] }, d: 1 },
            { ty: "st", c: { a: 0, k: [0.55, 0.4, 0.98, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 6 }, lc: 2, lj: 1, ml: 4 },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip: 0,
      op: 90,
      st: 0,
      bm: 0,
    },
  ],
};
