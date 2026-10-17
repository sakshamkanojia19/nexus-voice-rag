import type { VoiceOption } from "@/hooks/useSpeech";

/** A selectable voice persona, derived from a REAL browser TTS voice.
 *  `voiceName` is the exact SpeechSynthesis voice name we select; `name` is a
 *  cleaned, friendly label. Hues stay in the violet family for a cohesive look. */
export interface VoiceAgent {
  id: string; // = voiceName (exact, unique)
  name: string; // friendly persona display name (CiteTalk-style character)
  voiceLabel: string; // the real system voice, cleaned (for transparency)
  voiceName: string; // exact browser voice to select
  tagline: string;
  accent: string; // human-readable language/region
  lang: string; // BCP-47 tag, drives the greeting bubble
  hue: number; // violet-family hue for the doodle
  offline: boolean;
  seed: number; // drives the doodle's features (hair, eyes, accessory)
  gender: "f" | "m" | "n";
}

/** Strip vendor noise from a raw voice name → a short, friendly label.
 *  e.g. "Microsoft Aria Online (Natural) - English (United States)" → "Aria"
 *       "Google US English"                                          → "Google US English" */
function cleanName(raw: string): string {
  let n = raw.split(" - ")[0]; // drop the trailing "- English (United States)"
  n = n
    .replace(/\bmicrosoft\b/gi, "")
    .replace(/\bonline\b/gi, "")
    .replace(/\bdesktop\b/gi, "")
    .replace(/\(natural\)/gi, "")
    .replace(/\(enhanced\)/gi, "")
    .replace(/\bnatural\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return n || raw;
}

const LANG_LABELS: Record<string, string> = {
  "en-us": "US English",
  "en-gb": "UK English",
  "en-in": "Indian English",
  "en-au": "Australian English",
  "en-ca": "Canadian English",
  "en-ie": "Irish English",
  "en-za": "South African English",
  "hi-in": "Hindi",
  "es-es": "Spanish",
  "es-mx": "Spanish (Mexico)",
  "fr-fr": "French",
  "de-de": "German",
  "it-it": "Italian",
  "pt-br": "Portuguese (Brazil)",
  "ja-jp": "Japanese",
  "ko-kr": "Korean",
  "zh-cn": "Chinese",
};

function langLabel(lang: string): string {
  const key = lang.toLowerCase();
  if (LANG_LABELS[key]) return LANG_LABELS[key];
  // Generic fallback via Intl when available.
  try {
    const [base, region] = key.split("-");
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    const langName = dn.of(base) ?? base.toUpperCase();
    return region ? `${langName} (${region.toUpperCase()})` : langName;
  } catch {
    return lang;
  }
}

/** A native greeting per language — shown in the persona's speech bubble. */
const GREETINGS: Record<string, string> = {
  "en-in": "Namaste!", "en-gb": "Hiya!", "en-au": "G'day!", "en-ie": "Howya!",
  en: "Hello!", hi: "नमस्ते!", es: "¡Hola!", fr: "Bonjour !", de: "Hallo!",
  it: "Ciao!", pt: "Olá!", nl: "Hallo!", sv: "Hej!", pl: "Cześć!", tr: "Merhaba!",
  ru: "Привет!", ar: "مرحبا!", ja: "こんにちは!", ko: "안녕!", zh: "你好!",
  th: "สวัสดี!", vi: "Xin chào!", id: "Halo!", bn: "নমস্কার!", ta: "வணக்கம்!", te: "నమస్కారం!",
};

export function greetingFor(lang: string): string {
  const key = lang.toLowerCase();
  return GREETINGS[key] ?? GREETINGS[key.split("-")[0]] ?? "Hello!";
}

/** Deterministic violet-family hue spread across the list. */
function hueForIndex(i: number): number {
  return 232 + ((i * 41) % 84); // 232 → 316, cycles within violet/magenta
}

// Friendly persona names so each real voice gets a CiteTalk-style "character".
// Used when a voice's language has no regional pool below.
const NAMES_F = ["Nova", "Maya", "Mira", "Lila", "Zara", "Ines", "Vera", "Noor", "Elena", "Sonia"];
const NAMES_M = ["Marcus", "Leo", "Eli", "Sam", "Noah", "Milo", "Felix", "Jude", "Ezra", "Nico"];
const NAMES_N = ["Sky", "Ray", "Sage", "Jules", "Robin", "Ari", "Quinn", "Rowan"];

/**
 * Region-appropriate persona names, keyed by full BCP-47 tag first, then base
 * language. A Hindi voice introducing itself as "Marcus" undercuts the persona
 * the moment it speaks — the name should sound like the voice. Names were
 * picked to be common and friendly in each locale, not stereotypes; the
 * fallback pools above cover anything unlisted.
 */
const NAMES_BY_LANG: Record<string, { f: string[]; m: string[]; n?: string[] }> = {
  "hi": { f: ["Priya", "Ananya", "Meera", "Kavya", "Ishita", "Diya"], m: ["Arjun", "Rohan", "Kabir", "Aditya", "Vivaan", "Dev"], n: ["Kiran", "Noor"] },
  // English-India voices (Heera, Ravi…) speak with Indian names too.
  "en-in": { f: ["Priya", "Ananya", "Meera", "Kavya", "Ishita", "Diya"], m: ["Arjun", "Rohan", "Kabir", "Aditya", "Vivaan", "Dev"], n: ["Kiran", "Noor"] },
  "en-gb": { f: ["Poppy", "Charlotte", "Amelia", "Imogen", "Florence"], m: ["Kai", "Oliver", "George", "Alfie", "Harry"] },
  "en-us": { f: ["Aria", "Ava", "Harper", "Zoe", "Madison"], m: ["Theo", "Ethan", "Mason", "Tyler", "Cole"] },
  "en-au": { f: ["Matilda", "Sienna", "Ruby"], m: ["Jack", "Lachlan", "Banjo"] },
  "en-ie": { f: ["Saoirse", "Aoife"], m: ["Cillian", "Declan"] },
  "es": { f: ["Lucía", "Sofía", "Carmen", "Valentina"], m: ["Mateo", "Diego", "Javier", "Álvaro"] },
  "fr": { f: ["Camille", "Léa", "Chloé", "Manon"], m: ["Hugo", "Louis", "Théo", "Gaspard"] },
  "de": { f: ["Greta", "Lena", "Frieda", "Marlene"], m: ["Otto", "Jonas", "Lukas", "Emil"] },
  "it": { f: ["Giulia", "Chiara", "Alessia"], m: ["Luca", "Marco", "Matteo"] },
  "pt": { f: ["Beatriz", "Camila", "Luana"], m: ["Thiago", "Rafael", "Caio"] },
  "nl": { f: ["Fleur", "Sanne"], m: ["Daan", "Bram"] },
  "sv": { f: ["Elsa", "Freja"], m: ["Axel", "Nils"] },
  "pl": { f: ["Zofia", "Kasia"], m: ["Jakub", "Piotr"] },
  "tr": { f: ["Elif", "Zeynep"], m: ["Emre", "Kerem"] },
  "ru": { f: ["Anya", "Katya"], m: ["Dmitri", "Nikita"] },
  "ar": { f: ["Layla", "Amira"], m: ["Omar", "Karim"] },
  "ja": { f: ["Yui", "Sakura", "Hana"], m: ["Haruto", "Ren", "Sota"] },
  "ko": { f: ["Jiwoo", "Seoyeon"], m: ["Minjun", "Jihun"] },
  "zh": { f: ["Meilin", "Xiaoyu"], m: ["Wei", "Junjie"] },
  "th": { f: ["Malee"], m: ["Anon"] },
  "vi": { f: ["Linh"], m: ["Minh"] },
  "id": { f: ["Putri"], m: ["Bayu"] },
  "bn": { f: ["Rima"], m: ["Anik"] },
  "ta": { f: ["Kavitha"], m: ["Suresh"] },
  "te": { f: ["Lakshmi"], m: ["Ravi"] },
};

/** The name pool that matches a voice's language and gender, most specific
 *  first: exact tag ("en-gb"), then base language ("en"), then the global
 *  fallback pools. */
function poolFor(lang: string, gender: "f" | "m" | "n"): string[] {
  const key = (lang || "").toLowerCase();
  const regional = NAMES_BY_LANG[key] ?? NAMES_BY_LANG[key.split("-")[0] ?? ""];
  if (regional) {
    if (gender === "n") return regional.n ?? NAMES_N;
    const pool = regional[gender];
    if (pool.length) return pool;
  }
  return gender === "f" ? NAMES_F : gender === "m" ? NAMES_M : NAMES_N;
}

function guessGender(name: string): "f" | "m" | "n" {
  if (/\b(female|woman)\b|zira|aria|sonia|hazel|samantha|jenny|emma|heera|neerja|swara|priya|libby|michelle|ava|salli|joanna/i.test(name)) return "f";
  if (/\b(male|man)\b|david|mark|guy|george|james|ravi|prabhat|brian|christopher|daniel|alex|fred|eric/i.test(name)) return "m";
  return "n";
}

/**
 * Exact-voice-name → persona lookup for the reply-voice menus.
 *
 * Persona names are assigned by INDEX into the full voice list, so every
 * consumer must derive them from the same list the strip and page use —
 * otherwise "Kai" in the picker and "Kai" on the agent card could be two
 * different voices. Centralising the map is what keeps the name honest.
 */
export function agentsByVoiceName(voices: VoiceOption[]): Map<string, VoiceAgent> {
  return new Map(voicesToAgents(voices).map((a) => [a.voiceName, a]));
}

/**
 * The strip's shortlist: up to `limit` agents chosen for VARIETY rather than
 * list position. A raw slice of the roster shows five near-identical English
 * voices; this keeps one per (language, gender) first — offline voices ahead,
 * because they always work — then fills remaining slots in roster order.
 * Output preserves roster order so the shortlist matches the full page.
 */
export function topAgents(agents: VoiceAgent[], limit = 12): VoiceAgent[] {
  const ranked = [...agents].sort((a, b) => Number(b.offline) - Number(a.offline));
  const seen = new Set<string>();
  const diverse: VoiceAgent[] = [];
  const rest: VoiceAgent[] = [];
  for (const agent of ranked) {
    const key = `${agent.lang.toLowerCase()}|${agent.gender}`;
    if (seen.has(key)) rest.push(agent);
    else {
      seen.add(key);
      diverse.push(agent);
    }
  }
  const chosen = new Set([...diverse, ...rest].slice(0, limit).map((a) => a.id));
  return agents.filter((a) => chosen.has(a.id));
}

/** Turn the browser's real voices into selectable agent personas. */
export function voicesToAgents(voices: VoiceOption[]): VoiceAgent[] {
  const used = new Set<string>();
  const pick = (pool: string[], i: number): string => {
    for (let k = 0; k < pool.length; k++) {
      const n = pool[(i + k) % pool.length];
      if (!used.has(n)) { used.add(n); return n; }
    }
    const n = `${pool[i % pool.length]} ${Math.floor(i / pool.length) + 1}`;
    used.add(n);
    return n;
  };
  return voices.map((v, i) => {
    const gender = guessGender(v.name);
    const pool = poolFor(v.lang, gender);
    return {
      id: v.name,
      voiceName: v.name,
      name: pick(pool, i),
      voiceLabel: cleanName(v.name),
      tagline: v.offline ? "On-device · always available" : "Cloud voice · needs internet",
      accent: langLabel(v.lang),
      lang: v.lang,
      hue: hueForIndex(i),
      offline: v.offline,
      seed: i,
      gender,
    };
  });
}
