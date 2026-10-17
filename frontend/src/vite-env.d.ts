/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_BOT_NAME?: string;
  readonly VITE_DEFAULT_LANG?: string;
  readonly VITE_STT_MODE?: "auto" | "webspeech" | "whisper";
  readonly VITE_TTS_VOICE?: string;
  readonly VITE_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
