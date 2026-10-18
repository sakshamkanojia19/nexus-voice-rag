/** Centralised, type-safe access to Vite env vars. */
export const config = {
  apiUrl: import.meta.env.VITE_API_URL || "http://localhost:8001",
  appName: import.meta.env.VITE_APP_NAME || "nexus",
  botName: import.meta.env.VITE_BOT_NAME || "Nexus",
  // Where the landing page's GitHub links point.
  repoUrl: (import.meta.env.VITE_REPO_URL || "https://github.com/sakshamkanojia19/nexus-voice-rag").replace(/\/$/, ""),
  authorUrl: import.meta.env.VITE_AUTHOR_URL || "https://github.com/sakshamkanojia19",
  defaultLang: import.meta.env.VITE_DEFAULT_LANG || "en-IN",
  sttMode: (import.meta.env.VITE_STT_MODE || "auto") as "auto" | "webspeech" | "whisper",
  // Default agent is Zoe, whose underlying system voice is "Aria". Named
  // rather than "female" because the auto-picker prefers on-device voices, and
  // Aria is an Online (Natural) voice — left to the heuristic it would always
  // lose to Zira. pickVoice() falls back to the local tiers when Aria is not
  // installed, so a machine without it still gets a working voice.
  ttsVoice: import.meta.env.VITE_TTS_VOICE || "aria",
  debug: (import.meta.env.VITE_DEBUG || "false").toLowerCase() === "true" || runtimeDebug(),
} as const;

/**
 * Logs on a deployed build without a rebuild: `?debug=1` turns them on and is
 * remembered in this browser, `?debug=0` turns them off again. A production
 * voice bug is only diagnosable from the browser that hit it, and VITE_DEBUG is
 * baked in at build time.
 */
function runtimeDebug(): boolean {
  const KEY = "nexus:debug";
  try {
    const flag = new URLSearchParams(window.location.search).get("debug");
    if (flag === "1") window.localStorage.setItem(KEY, "1");
    else if (flag === "0") window.localStorage.removeItem(KEY);
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function debugLog(...args: unknown[]): void {
  if (config.debug) console.log("[Nexus]", ...args);
}
