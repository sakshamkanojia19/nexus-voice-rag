/** Centralised, type-safe access to Vite env vars. */
export const config = {
  apiUrl: import.meta.env.VITE_API_URL || "http://localhost:8001",
  appName: import.meta.env.VITE_APP_NAME || "nexus",
  botName: import.meta.env.VITE_BOT_NAME || "Nexus",
  // Where the landing page's GitHub links point.
  repoUrl: (import.meta.env.VITE_REPO_URL || "https://github.com/sakshamkanojia19/nexus").replace(/\/$/, ""),
  authorUrl: import.meta.env.VITE_AUTHOR_URL || "https://github.com/sakshamkanojia19",
  defaultLang: import.meta.env.VITE_DEFAULT_LANG || "en-IN",
  sttMode: (import.meta.env.VITE_STT_MODE || "auto") as "auto" | "webspeech" | "whisper",
  // Default agent is Zoe, whose underlying system voice is "Aria". Named
  // rather than "female" because the auto-picker prefers on-device voices, and
  // Aria is an Online (Natural) voice — left to the heuristic it would always
  // lose to Zira. pickVoice() falls back to the local tiers when Aria is not
  // installed, so a machine without it still gets a working voice.
  ttsVoice: import.meta.env.VITE_TTS_VOICE || "aria",
  debug: (import.meta.env.VITE_DEBUG || "false").toLowerCase() === "true",
} as const;

export function debugLog(...args: unknown[]): void {
  if (config.debug) console.log("[Nexus]", ...args);
}
