/** Conversation languages — drives speech recognition (Web Speech + Whisper),
 *  the reply language, and TTS voice preference. */
export interface Lang {
  /** BCP-47 tag used for Web Speech recognition + TTS voice matching. */
  code: string;
  /** English label shown in the picker. */
  label: string;
  /** Native-script name (for the reply-language instruction + display). */
  native: string;
}

export const LANGUAGES: Lang[] = [
  { code: "en-US", label: "English (US)", native: "English" },
  { code: "en-GB", label: "English (UK)", native: "English" },
  { code: "en-IN", label: "English (India)", native: "English" },
  { code: "hi-IN", label: "Hindi", native: "हिन्दी" },
  { code: "bn-IN", label: "Bengali", native: "বাংলা" },
  { code: "ta-IN", label: "Tamil", native: "தமிழ்" },
  { code: "te-IN", label: "Telugu", native: "తెలుగు" },
  { code: "mr-IN", label: "Marathi", native: "मराठी" },
  { code: "gu-IN", label: "Gujarati", native: "ગુજરાતી" },
  { code: "pa-IN", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "ur-PK", label: "Urdu", native: "اردو" },
  { code: "es-ES", label: "Spanish", native: "Español" },
  { code: "fr-FR", label: "French", native: "Français" },
  { code: "de-DE", label: "German", native: "Deutsch" },
  { code: "ar-SA", label: "Arabic", native: "العربية" },
  { code: "zh-CN", label: "Chinese", native: "中文" },
  { code: "ja-JP", label: "Japanese", native: "日本語" },
];

export const DEFAULT_LANG = "en-US";
const LANG_STORAGE_KEY = "nexus_conv_lang";

export function findLang(code: string): Lang {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/** The language name to give the model for its reply (e.g. "Hindi", "English"). */
export function replyLanguageName(code: string): string {
  return findLang(code).label.replace(/\s*\(.*\)\s*/, "").trim();
}

/** Short chip label, e.g. "EN · US" → we just show the label. */
export function langChipLabel(code: string): string {
  return findLang(code).label;
}

export function loadLang(): string {
  if (typeof window === "undefined") return DEFAULT_LANG;
  const saved = localStorage.getItem(LANG_STORAGE_KEY);
  return saved && LANGUAGES.some((l) => l.code === saved) ? saved : DEFAULT_LANG;
}

export function saveLang(code: string): void {
  if (typeof window !== "undefined") localStorage.setItem(LANG_STORAGE_KEY, code);
}
