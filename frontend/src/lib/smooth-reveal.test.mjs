// Exercises the real src/lib/smooth-reveal.ts: a burst becomes a short sweep,
// never a crawl, and never a lag that grows.
import { LAG_MS, nextLength, wasReplaced } from "./smooth-reveal.ts";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `   → ${detail}`}`);
};

const FRAME = 1000 / 60;
const burst = "Pizza is a flat, round dough base topped with sauce, cheese and toppings. ".repeat(6);

{
  // A 450-character burst lands at once. How long until it is all on screen?
  let shown = 0;
  let ms = 0;
  while (shown < burst.length && ms < 5000) {
    shown = nextLength(shown, burst, FRAME);
    ms += FRAME;
  }
  check("a burst drains within a few lag windows", ms <= LAG_MS * 6, `${ms.toFixed(0)}ms`);
  check("a burst is not dumped in one frame", nextLength(0, burst, FRAME) < burst.length / 4);
}

{
  let shown = 0;
  let ok = true;
  while (shown < burst.length) {
    const next = nextLength(shown, burst, FRAME);
    if (next <= shown) { ok = false; break; }
    if (next < burst.length && !/\s/.test(burst[next])) { ok = false; break; }
    shown = next;
  }
  check("reveals always advance and stop on word boundaries", ok, `stalled or split at ${shown}`);
}

check("a short backlog does not crawl", nextLength(0, "Hello there", FRAME) > 0);
check("already caught up stays put", nextLength(11, "Hello there", FRAME) === 11);
check("a huge frame gap (background tab) is capped", nextLength(0, burst, 60_000) < burst.length);
check("an extension is not a replacement", !wasReplaced("Pizza is", "Pizza is a dough", 8));
check("a replaced text is detected", wasReplaced("Pizza is a dough", "Couldn't reach the server.", 10));

console.log(failed ? `\n${failed} check(s) failed` : "\nall smooth-reveal checks passed");
if (failed) process.exit(1);
