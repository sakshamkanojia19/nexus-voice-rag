// Persona naming: a voice should introduce itself with a name that sounds
// like the voice — Hindi voices get Indian names, German voices German ones,
// and the mapping must be deterministic and collision-free across the roster.
import { voicesToAgents, agentsByVoiceName, topAgents } from "./agents.ts";

const voices = [
  { name: "Microsoft Swara - Hindi (India)", lang: "hi-IN", offline: true },
  { name: "Microsoft Heera - English (India)", lang: "en-IN", offline: true },
  { name: "Microsoft Zira - English (United States)", lang: "en-US", offline: true },
  { name: "Microsoft George - English (United Kingdom)", lang: "en-GB", offline: true },
  { name: "Google Deutsch", lang: "de-DE", offline: false },
  { name: "Microsoft Hazel - English (Great Britain)", lang: "en-GB", offline: true },
  { name: "Some Unknown Voice", lang: "xx-XX", offline: false },
];

const HINDI_F = ["Priya", "Ananya", "Meera", "Kavya", "Ishita", "Diya"];
const UK_M = ["Kai", "Oliver", "George", "Alfie", "Harry"];
const UK_F = ["Poppy", "Charlotte", "Amelia", "Imogen", "Florence"];
const US_F = ["Aria", "Ava", "Harper", "Zoe", "Madison"];

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `   → ${detail}`}`);
};

const agents = voicesToAgents(voices);
const byId = Object.fromEntries(agents.map((a) => [a.voiceName, a]));

check(
  "Hindi female voice gets an Indian female name",
  HINDI_F.includes(byId["Microsoft Swara - Hindi (India)"].name),
  byId["Microsoft Swara - Hindi (India)"].name,
);
check(
  "English (India) voice also gets an Indian name",
  HINDI_F.includes(byId["Microsoft Heera - English (India)"].name),
  byId["Microsoft Heera - English (India)"].name,
);
check(
  "US female voice gets a US-pool name",
  US_F.includes(byId["Microsoft Zira - English (United States)"].name),
  byId["Microsoft Zira - English (United States)"].name,
);
check(
  "UK male voice gets a UK-pool name",
  UK_M.includes(byId["Microsoft George - English (United Kingdom)"].name),
  byId["Microsoft George - English (United Kingdom)"].name,
);
check(
  "UK female voice gets a UK-pool name",
  UK_F.includes(byId["Microsoft Hazel - English (Great Britain)"].name),
  byId["Microsoft Hazel - English (Great Britain)"].name,
);
check(
  "unknown language falls back to the global pools without crashing",
  typeof byId["Some Unknown Voice"].name === "string" && byId["Some Unknown Voice"].name.length > 0,
);

// No two agents may share a name — the pickers show names, not voice ids.
const names = agents.map((a) => a.name);
check("names are unique across the roster", new Set(names).size === names.length, names.join(", "));

// Deterministic: the same voices always get the same personas.
const again = voicesToAgents(voices).map((a) => a.name);
check("mapping is deterministic", JSON.stringify(names) === JSON.stringify(again));

// The lookup used by the reply-voice menus agrees with the cards.
const lookup = agentsByVoiceName(voices);
check(
  "menu lookup matches the card names",
  agents.every((a) => lookup.get(a.voiceName)?.name === a.name),
);

// topAgents keeps roster order and never exceeds the limit.
const top = topAgents(agents, 3);
check("topAgents respects the limit", top.length <= 3, String(top.length));

console.log(`\n${failed === 0 ? "all agent naming checks passed" : failed + " failed"}`);
process.exit(failed ? 1 : 0);
