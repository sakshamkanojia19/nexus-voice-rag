import { useCallback, useEffect, useRef, useState } from "react";
import { config, debugLog } from "@/lib/config";
import { openingClause } from "@/lib/speech-chunk";
import { scriptLanguage } from "@/lib/script-lang";

// Voice-name preference ordering — punchy first, soft fallbacks last.
const FEMALE_HINTS: RegExp[] = [
  // Reliable offline / system female voices first (work even with no net).
  /zira/i, /hazel/i, /catherine/i, /heera/i,                                  // Windows offline
  /samantha/i, /karen/i, /allison/i, /victoria/i, /tessa/i, /susan/i, /fiona/i, // Apple offline
  // Then Google's (offline once downloaded by Chrome).
  /google.*english.*female/i, /google.*hindi/i, /google.*us.*english/i,
  // Then Microsoft punchy voices (often "Online" so used only when offline ones missing).
  /\baria\b/i, /\bjenny\b/i, /\bemma\b/i, /\bsonia\b/i, /\bmichelle\b/i,
  /\bava\b/i, /\bclara\b/i, /\bnatasha\b/i,
  /\bneerja\b/i, /\bswara\b/i, /\bkavya\b/i, /\bananya\b/i,
  /\bjoanna\b/i, /\bkendra\b/i, /\bsalli\b/i,
  /\bnova\b/i, /\bshimmer\b/i,
  // Generic last resort.
  /female/i, /\bwoman\b/i,
];

// Voices with "Online" in the name stream audio from a cloud service and
// silently fail when network is flaky. Treat them as a last resort.
const isOnlineVoice = (v: SpeechSynthesisVoice): boolean => /\bonline\b/i.test(v.name);
const MALE_HINTS: RegExp[] = [
  /\bmale\b/i, /\bman\b/i,
  /david/i, /mark/i, /george/i, /james/i,
  /alex/i, /daniel/i, /fred/i, /tom/i,
  /\becho\b/i, /\bonyx\b/i, /\bguy\b/i,
];
const QUALITY_HINTS: RegExp[] = [/natural/i, /neural/i, /enhanced/i, /premium/i, /google/i];

function pickVoice(lang: string, preference: string): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const wantFull = lang.toLowerCase();
  const wantShort = wantFull.slice(0, 2);
  const exact = voices.filter((v) => v.lang.toLowerCase() === wantFull);
  const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(wantShort));
  // In Auto mode never pin an unrelated language voice (for example en-US
  // Zira for hi-IN). Returning null lets speechSynthesis select the platform's
  // default voice for the requested utterance.lang instead.
  const pool = exact.length ? exact : sameLang;
  if (!pool.length) return null;

  // Tier-by-offline-first: search offline voices first within each step,
  // only fall back to "Online" voices if no offline option exists.
  const offlinePool = pool.filter((v) => !isOnlineVoice(v));
  const tiered = offlinePool.length > 0 ? [offlinePool, pool] : [pool];

  const want = preference.toLowerCase().trim();

  // A named preference is a request for *that voice*, so it outranks the
  // offline-first tiering rather than competing inside it. Searched across the
  // whole pool before any tier runs: asking for "aria" and being handed Zira
  // because Zira happens to be on-device is not a fallback, it is the wrong
  // voice. The tiers below still decide everything when the name isn't found,
  // so a machine without that voice degrades to the best local one.
  if (want && want !== "female" && want !== "male") {
    const named = pool.find((v) => v.name.toLowerCase().includes(want));
    if (named) return named;
  }

  for (const tier of tiered) {
    const hints = want === "male" ? MALE_HINTS : FEMALE_HINTS;
    for (const re of hints) {
      const hit = tier.find((v) => re.test(v.name));
      if (hit) return hit;
    }
    for (const q of QUALITY_HINTS) {
      const hit = tier.find((v) => q.test(v.name));
      if (hit) return hit;
    }
  }
  return pool[0] ?? null;
}

/** ALL real voices ordered the way pickVoice() would prefer them. Used both for
 *  retry-with-fallback and to populate the picker/Voice-Agents UI, so it keeps
 *  every voice the browser exposes (offline + online) rather than dropping any —
 *  current-language voices are simply sorted to the front. */
function rankedVoices(lang: string, preference: string): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return [];
  const wantShort = lang.toLowerCase().slice(0, 2);

  const score = (v: SpeechSynthesisVoice): number => {
    let s = 0;
    if (v.lang.toLowerCase().startsWith(wantShort)) s += 1000; // current language first
    if (!isOnlineVoice(v)) s += 100;
    const name = v.name;
    const hints = preference === "male" ? MALE_HINTS : FEMALE_HINTS;
    hints.forEach((re, i) => { if (re.test(name)) s += 50 - i; });
    QUALITY_HINTS.forEach((re, i) => { if (re.test(name)) s += 10 - i; });
    return s;
  };
  return [...voices].sort((a, b) => score(b) - score(a));
}

/** The voice to read `text` with: the call's voice, unless the text is in a
 *  script that voice's language doesn't use — then the best installed voice for
 *  the text's own language. Falls back to the call's voice (with a log line)
 *  when the device has none, since that is no worse than before. */
function voiceForText(
  text: string,
  current: SpeechSynthesisVoice | null,
  lang: string,
  preference: string,
): SpeechSynthesisVoice | null {
  const textLang = scriptLanguage(text, lang);
  if (!textLang || (current?.lang ?? lang).toLowerCase().startsWith(textLang)) return current;
  const match = rankedVoices(textLang, preference).find((v) => v.lang.toLowerCase().startsWith(textLang));
  if (!match) debugLog(`TTS: no ${textLang} voice installed — reading with ${current?.name ?? "the default voice"}`);
  return match ?? current;
}

// Persisted explicit voice choice (overrides the auto-picker).
const SELECTED_VOICE_KEY = "ucb_tts_voice";

/** Strip Markdown / code / citations / URLs so TTS reads natural prose, not
 *  symbols like "asterisk asterisk" or "bracket one". */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " . ")          // drop code blocks entirely
    .replace(/`([^`]+)`/g, "$1")                  // inline code → its text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")    // links/images → label
    .replace(/\[\d+\]/g, "")                      // [1] citation markers
    .replace(/https?:\/\/\S+/g, "")               // bare URLs
    // A bare domain is said the way a person says it: "console dot x dot ai".
    // Left alone, its dots read as sentence ends — the chunker split
    // "console.x.ai" mid-word and the listener heard "ai site)".
    .replace(/\b(?:[a-z0-9-]+\.)+(?:ai|com|io|org|net|dev|app|co|in|gov|edu)\b/gi, (d) => d.replace(/\./g, " dot "))
    .replace(/\(\s*\)/g, "")                       // parens emptied by the above
    .replace(/^#{1,6}\s+/gm, "")                  // heading hashes
    .replace(/^\s*>\s?/gm, "")                     // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, "")                 // list bullets
    .replace(/(\*\*|__|\*|_|~~)/g, "")            // bold/italic/strike markers
    .replace(/\|/g, " ")                           // table pipes
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface VoiceOption {
  name: string;
  lang: string;
  offline: boolean;
}

/** De-duplicated, ranked list of voices for the picker UI (current lang first). */
function listVoiceOptions(lang: string, preference: string): VoiceOption[] {
  const seen = new Set<string>();
  const out: VoiceOption[] = [];
  for (const v of rankedVoices(lang, preference)) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    out.push({ name: v.name, lang: v.lang, offline: !isOnlineVoice(v) });
  }
  return out;
}

export interface UseSpeechReturn {
  /**
   * Read text aloud now. `force` bypasses the "voice replies" toggle: that
   * setting governs whether answers are read *automatically*, and pressing a
   * speaker button on a specific message is an explicit request that should
   * work regardless — the same reasoning as `previewVoice`.
   */
  speak: (text: string, options?: { force?: boolean }) => void;
  cancel: () => void;
  unlock: () => void;
  test: () => void;
  previewVoice: (name: string, text?: string) => void;
  /** Streamed TTS: reset → push accumulated text repeatedly → end. */
  streamReset: () => void;
  streamPush: (full: string) => void;
  streamEnd: (full: string) => void;
  /** Pause mid-utterance on a *suspected* barge-in, keeping the queue intact. */
  hold: () => void;
  /** Resume after hold() when the barge-in turned out to be a false positive. */
  release: () => void;
  /** True while playback is held. */
  held: () => boolean;
  /** The portion of the current reply that actually reached the speaker. */
  getSpokenText: () => string;
  /** 0..1 speech energy for visualizers, decaying after each word boundary. */
  getSpeechPulse: () => number;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  speaking: boolean;
  voiceName: string | null;
  voices: VoiceOption[];
  selectedVoice: string | null;
  selectVoice: (name: string | null) => void;
  supported: boolean;
}

export interface UseSpeechOptions {
  lang?: string;
  preference?: string;
  enabled?: boolean;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/** Browser TTS using SpeechSynthesis. Free, OS voices, instant. */
export function useSpeech(opts: UseSpeechOptions = {}): UseSpeechReturn {
  const lang = opts.lang ?? config.defaultLang;
  const preference = opts.preference ?? config.ttsVoice;
  const rate = opts.rate ?? 1.08;
  const pitch = opts.pitch ?? 1.05;
  const volume = opts.volume ?? 1.0;

  const [enabled, setEnabled] = useState(opts.enabled ?? true);
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  voiceRef.current = voice;
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(() =>
    typeof window === "undefined" ? null : localStorage.getItem(SELECTED_VOICE_KEY),
  );
  // Bumped on every new speak()/cancel() so stale async callbacks bail out —
  // this is what prevents two utterances from overlapping.
  const speakTokenRef = useRef(0);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  // True only while WE paused playback on a suspected barge-in. Distinguishes an
  // intentional hold from Chrome's spontaneous pause so the watchdog below
  // doesn't immediately undo it.
  const heldRef = useRef(false);

  // ── Speech energy for visualizers ──────────────────────────────────────────
  // SpeechSynthesis exposes no PCM, so there is no true amplitude to read. What
  // it does give is `onboundary`, one event per spoken word — enough to drive a
  // visualizer that actually tracks the cadence of the voice instead of miming
  // it. Each boundary stamps the clock; the getter decays from it, so the
  // reading rises on every word and falls through the gaps between them.
  const boundaryAtRef = useRef(0);
  /** Smoothed gap between boundaries — the speaker's actual word rate. */
  const boundaryGapRef = useRef(0);
  /** True once this utterance has produced at least one boundary, so we know
   *  whether the engine supports them at all. */
  const sawBoundaryRef = useRef(false);

  /** Fallback word rate when the engine emits no boundaries, in words/second.
   *  Ordinary speech at rate 1.08 lands near here. */
  const ASSUMED_WORDS_PER_SEC = 3.2;
  /** Envelope bounds. A word's energy has to fall far enough to read as a
   *  separate word, but not so fast that fast speech becomes a flicker. The
   *  ceiling is generous so a slow, deliberate voice gets one long deep swell
   *  per word instead of a short pulse followed by dead air. */
  const PULSE_MIN_MS = 140;
  const PULSE_MAX_MS = 560;

  /** Forget the previous reply's cadence. Without this, a voice that emits no
   *  boundaries inherits `sawBoundary` from the last one that did, and the orb
   *  freezes for the whole reply. */
  const resetPulse = useCallback(() => {
    boundaryAtRef.current = 0;
    boundaryGapRef.current = 0;
    sawBoundaryRef.current = false;
  }, []);

  const markBoundary = useCallback(() => {
    const now = Date.now();
    const previous = boundaryAtRef.current;
    if (previous) {
      const gap = now - previous;
      // Ignore sentence pauses when estimating cadence. Within a phrase, ease
      // toward the new rate so one unusually short word cannot make the orb
      // visibly twitch faster than the voice.
      if (gap >= 60 && gap <= 1200) {
        boundaryGapRef.current = boundaryGapRef.current
          ? boundaryGapRef.current * 0.65 + gap * 0.35
          : gap;
      }
    }
    boundaryAtRef.current = now;
    sawBoundaryRef.current = true;
  }, []);

  /**
   * 0..1 energy for the current instant of speech.
   *
   * Shaped like a syllable rather than a sawtooth: a near-instant attack, then
   * a cosine fall. The old linear ramp read as a sputter because the eye
   * catches the corner at each word start; a cosine has no corner and the orb
   * looks like it is being pushed by breath instead of flicked.
   *
   * The window tracks the speaker's measured word rate, so fast speech gives
   * quick, shallow pulses and slow speech gives long, deep ones — which is what
   * makes the motion read as *this* voice rather than a generic throb.
   */
  const getSpeechPulse = useCallback(() => {
    // Some engines never fire `onboundary` (several Windows SAPI voices among
    // them). Without this the orb would sit perfectly still through an entire
    // spoken reply, which looks broken rather than calm.
    if (!sawBoundaryRef.current) {
      if (!window.speechSynthesis?.speaking) return 0;
      const period = 1000 / (ASSUMED_WORDS_PER_SEC * rate);
      const phase = (Date.now() % period) / period;
      return 0.5 + 0.42 * Math.cos(phase * Math.PI * 2);
    }

    const since = Date.now() - boundaryAtRef.current;
    if (since < 0) return 0;
    // Follow the measured cadence, clamped so a long pause between sentences
    // doesn't stretch one word's envelope across the whole gap.
    const window_ = Math.min(
      PULSE_MAX_MS,
      Math.max(PULSE_MIN_MS, boundaryGapRef.current || PULSE_MAX_MS),
    );
    // Fast voices use a slightly shallower breath so rapid words do not make
    // the shell chatter. Slow delivery gets the full contract/expand range.
    const depth = 0.72 + 0.28 * ((window_ - PULSE_MIN_MS) / (PULSE_MAX_MS - PULSE_MIN_MS));
    // One boundary opens the orb; it then contracts smoothly through the word.
    if (since <= window_) {
      return 0.5 + Math.cos((since / window_) * Math.PI) * depth * 0.5;
    }
    // Past the word's envelope: a pause in the voice. The old behaviour held
    // the floor value — full contraction — until the next boundary, so a slow
    // voice left the orb sitting motionless between words and the whole thing
    // read as lagging behind the speech. Instead, ease up to a slightly-drawn
    // rest and breathe there gently, so a pause looks like waiting to speak.
    const floor = 0.5 - depth * 0.5;
    const rest = 0.42;
    const settle = Math.min(1, (since - window_) / 500);
    const base = floor + (rest - floor) * settle;
    const idle = 0.09 * Math.sin(((since - window_) / 1000) * Math.PI * 2 * 0.9) * settle;
    return Math.max(0, Math.min(1, base + idle));
  }, [rate]);

  // Chrome silently pauses speechSynthesis after ~14s of nothing happening.
  // A cheap watchdog: every 5s, if the queue has work but we're paused, resume.
  useEffect(() => {
    if (!supported) return;
    const id = window.setInterval(() => {
      if (heldRef.current) return; // an intentional hold — leave it paused
      const s = window.speechSynthesis;
      if ((s.speaking || s.pending) && s.paused) s.resume();
    }, 5000);
    return () => window.clearInterval(id);
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const resolve = (): boolean => {
      const all = window.speechSynthesis.getVoices();
      if (!all.length) return false;
      setVoices(listVoiceOptions(lang, preference));
      // An explicit user choice wins; otherwise fall back to the auto-picker.
      const chosen =
        (selectedVoice && all.find((v) => v.name === selectedVoice)) ||
        pickVoice(lang, preference);
      if (chosen) {
        setVoice(chosen);
        debugLog("voice resolved:", chosen.name, chosen.lang, selectedVoice ? "(user)" : "(auto)");
        return true;
      }
      setVoice(null);
      debugLog("no matching installed voice for", lang, "- using browser language fallback");
      return false;
    };
    if (resolve()) return;
    const handler = (): void => {
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", handler);
    const safety = window.setTimeout(resolve, 1500);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", handler);
      window.clearTimeout(safety);
    };
  }, [lang, preference, supported, selectedVoice]);

  // ── Streaming TTS state (speak sentence-by-sentence as a reply arrives) ──
  const streamPosRef = useRef(0);
  const streamActiveRef = useRef(false);
  const streamQueueRef = useRef<string[]>([]);
  const streamPlayingRef = useRef(false);
  // When the reply's stream opened, so we can log time-to-first-audio.
  const streamStartedAtRef = useRef(0);

  // ── "What did the user actually hear?" ──────────────────────────────────────
  // Chunks that finished playing, plus how far into the current chunk the
  // synthesizer has spoken (via onboundary). On a real barge-in this is what the
  // conversation history should be truncated to — the model must not believe it
  // said sentences that were cut off before leaving the speaker.
  const spokenDoneRef = useRef<string[]>([]);
  const spokenPartialRef = useRef("");
  /** The stream chunk the synthesizer is on, so a hold can requeue its rest. */
  const currentChunkRef = useRef("");

  const resetSpoken = useCallback(() => {
    spokenDoneRef.current = [];
    spokenPartialRef.current = "";
  }, []);

  const getSpokenText = useCallback(
    () => [...spokenDoneRef.current, spokenPartialRef.current].join(" ").replace(/\s+/g, " ").trim(),
    [],
  );

  const cancel = useCallback(() => {
    speakTokenRef.current++; // invalidate any in-flight speak() callbacks
    streamActiveRef.current = false;
    streamQueueRef.current = [];
    streamPlayingRef.current = false;
    streamPosRef.current = 0;
    heldRef.current = false;
    resetPulse();
    setSpeaking(false);
    if (supported) {
      window.speechSynthesis.cancel();
      // `pause()` is global state on the synth, not a property of the utterance
      // it stopped, and `cancel()` does not clear it. Cancelling out of a
      // barge-in hold therefore leaves the engine paused with an empty queue:
      // the watchdog ignores it (nothing is speaking or pending), and the next
      // reply is handed to an engine that will not talk. Leave it running and
      // empty instead — resume() on an idle synth is a no-op.
      window.speechSynthesis.resume();
    }
  }, [supported]);

  /**
   * Stop playback for a *suspected* barge-in without losing the answer.
   *
   * Not `pause()`: with the cloud voices (Edge's "Online (Natural)" ones, and
   * Chrome's Google voices) pause is honoured only at the end of the sentence
   * being spoken, so the assistant talked over the user for two or three
   * seconds after it "stopped". `cancel()` is silent at once. What makes that
   * reversible is that the stream already tracks how far into the current
   * sentence the speaker got (onboundary): the unheard remainder goes back on
   * the front of the queue, and release() picks up on the word it stopped at.
   *
   * A one-off speak() — an acknowledgement, a non-streamed reply — has no queue
   * to resume from, so it still uses pause().
   */
  const hold = useCallback(() => {
    if (!supported || heldRef.current) return;
    const s = window.speechSynthesis;
    if (!streamPlayingRef.current && !s.speaking && !s.pending) return;
    heldRef.current = true;
    if (streamPlayingRef.current) {
      const current = currentChunkRef.current;
      const heard = spokenPartialRef.current;
      const remainder = current.slice(heard.length).trim();
      if (heard.trim()) spokenDoneRef.current.push(heard.trim());
      spokenPartialRef.current = "";
      if (remainder) streamQueueRef.current.unshift(remainder);
      streamPlayingRef.current = false;
      s.cancel();
    } else {
      s.pause();
    }
    debugLog("TTS: held (suspected barge-in)");
  }, [supported]);

  /** Release a hold() — the false-interruption recovery path. */
  const release = useCallback(() => {
    if (!supported || !heldRef.current) return;
    heldRef.current = false;
    const s = window.speechSynthesis;
    if (s.paused) s.resume();
    else if (streamQueueRef.current.length) playNextRef.current();
    else if (!streamActiveRef.current) setSpeaking(false);
    debugLog("TTS: released (false interruption)");
  }, [supported]);

  const held = useCallback(() => heldRef.current, []);

  // One-time warm-up: speak an empty utterance on first user gesture so
  // Chrome registers the page as "audio-allowed". Doesn't produce sound.
  const unlockedRef = useRef(false);
  const unlock = useCallback(() => {
    if (!supported || unlockedRef.current) return;
    try {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
      unlockedRef.current = true;
      debugLog("speechSynthesis unlocked");
    } catch (e) {
      debugLog("unlock failed", e);
    }
  }, [supported]);

  const speak = useCallback(
    (raw: string, options: { force?: boolean } = {}) => {
      if (!supported) { debugLog("TTS: speechSynthesis not supported"); return; }
      if (!enabled && !options.force) { debugLog("TTS: skipped (muted)"); return; }
      const text = cleanForSpeech(raw);
      if (!text.trim()) { debugLog("TTS: skipped (empty text)"); return; }

      const synth = window.speechSynthesis;
      // New utterance supersedes anything in flight (token guard) and any
      // queued/active speech (cancel) — guarantees a single voice at a time.
      const token = ++speakTokenRef.current;
      // Set synchronously so the conversation loop sees thinking → speaking with
      // no idle frame in between (which would prematurely re-arm the mic).
      setSpeaking(true);
      resetPulse();

      // Fallback chain: resolved/selected voice first, then ranked alternatives —
      // but we only advance on a REAL onerror, never on a speculative timer
      // (that timer used to start a 2nd voice while a slow one was spinning up).
      // Text in another script needs a voice for that language — the call's
      // voice would read it as silence (see lib/script-lang.ts).
      const textLang = scriptLanguage(text, lang);
      const mismatch = !!textLang && !(voice?.lang ?? lang).toLowerCase().startsWith(textLang);
      const speakLang = mismatch && textLang ? textLang : lang;
      const ranked = rankedVoices(speakLang, preference);
      const wantedLanguage = speakLang.toLowerCase().slice(0, 2);
      const candidates = voice && !mismatch
        ? ranked
        : ranked.filter((candidate) => candidate.lang.toLowerCase().startsWith(wantedLanguage));
      if (voice && !mismatch) {
        const i = candidates.findIndex((v) => v.name === voice.name);
        if (i > 0) candidates.splice(i, 1);
        if (candidates[0]?.name !== voice.name) candidates.unshift(voice);
      }
      debugLog("TTS: speak()", candidates.slice(0, 3).map((v) => v.name).join(" | "));

      const trySpeak = (idx: number): void => {
        if (token !== speakTokenRef.current) return; // superseded by a newer speak/cancel
        const v = candidates[idx] ?? null;
        const utter = new SpeechSynthesisUtterance(text);
        if (v) utter.voice = v;
        utter.lang = v?.lang ?? speakLang;
        utter.rate = rate;
        utter.pitch = pitch;
        utter.volume = volume;
        utter.onstart = () => debugLog("TTS start:", v?.name ?? "(default)");
        utter.onboundary = markBoundary;
        utter.onend = () => {
          debugLog("TTS end");
          if (token === speakTokenRef.current) setSpeaking(false);
        };
        utter.onerror = (e) => {
          const err = (e as SpeechSynthesisErrorEvent).error;
          // "canceled"/"interrupted" are expected when we replace speech — not failures.
          if (err === "canceled" || err === "interrupted") return;
          if (token !== speakTokenRef.current) return;
          console.warn("[Nexus] TTS error:", err, "voice=", v?.name);
          if (idx + 1 < candidates.length) {
            debugLog("TTS: voice errored, trying next:", candidates[idx + 1]?.name);
            window.setTimeout(() => trySpeak(idx + 1), 60);
          } else {
            setSpeaking(false); // exhausted all voices — stop the "speaking" state
          }
        };
        synth.resume();
        synth.speak(utter);
      };

      // Always start from a clean queue so a previous reply can't overlap.
      synth.cancel();
      window.setTimeout(() => {
        if (token === speakTokenRef.current) trySpeak(0);
      }, 60);
    },
    [enabled, lang, pitch, preference, rate, supported, voice, volume],
  );

  /** Speak a quick test phrase so the user can confirm audio is working. */
  const test = useCallback(() => {
    const phrase = "Audio test. If you can hear me, voice replies will work.";
    // Force-enable for the test; restore previous state isn't needed —
    // the user will see whether they hear it.
    if (!supported) {
      console.warn("[Nexus] speechSynthesis not supported in this browser.");
      return;
    }
    debugLog("TTS test: enabled=", enabled, "voice=", voice?.name);
    const synth = window.speechSynthesis;
    const utter = new SpeechSynthesisUtterance(phrase);
    if (voice) utter.voice = voice;
    utter.lang = lang;
    utter.rate = rate;
    utter.pitch = pitch;
    utter.volume = 1.0;
    utter.onerror = (e) =>
      console.warn("[Nexus] TTS test error:", (e as SpeechSynthesisErrorEvent).error);
    utter.onstart = () => console.log("[Nexus] TTS test started:", voice?.name);
    utter.onend = () => console.log("[Nexus] TTS test ended");
    synth.cancel();
    window.setTimeout(() => {
      synth.resume();
      synth.speak(utter);
    }, 30);
  }, [enabled, lang, pitch, rate, supported, voice]);

  /** Speak a short sample with an EXACT voice by name, right now. Bypasses the
   *  async `voice` state (which lags a tick behind selectVoice) and the muted
   *  flag, so picking a voice always produces immediate, audible feedback. */
  const previewVoice = useCallback(
    (name: string, text = "Hi, I'm here. This is how I'll sound when I read your answers.") => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      const v = synth.getVoices().find((x) => x.name === name) ?? voice;
      const token = ++speakTokenRef.current;
      synth.cancel();
      window.setTimeout(() => {
        if (token !== speakTokenRef.current) return;
        const utter = new SpeechSynthesisUtterance(text);
        if (v) {
          utter.voice = v;
          utter.lang = v.lang;
        }
        utter.rate = rate;
        utter.pitch = pitch;
        utter.volume = 1.0;
        utter.onerror = (e) => {
          const err = (e as SpeechSynthesisErrorEvent).error;
          if (err === "canceled" || err === "interrupted") return;
          console.warn("[Nexus] voice preview error:", err, "voice=", name);
        };
        synth.resume();
        synth.speak(utter);
      }, 60);
    },
    [supported, voice, rate, pitch],
  );

  // Build an utterance with the currently-resolved voice/lang/rate — or, when
  // the text is in another script, a voice that can read it.
  const makeUtterance = useCallback(
    (text: string) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = voiceForText(text, voiceRef.current, lang, preference);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else {
        u.lang = lang;
      }
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      return u;
    },
    [lang, preference, rate, pitch, volume],
  );

  // Play the next queued sentence; chains via onend. Ref so it's always current.
  const playNextRef = useRef<() => void>(() => {});
  playNextRef.current = () => {
    if (!supported) return;
    // Held for a suspected barge-in: sentences that stream in meanwhile queue
    // up behind the held remainder rather than talking over the user.
    if (heldRef.current) return;
    const synth = window.speechSynthesis;
    const next = streamQueueRef.current.shift();
    if (next === undefined) {
      streamPlayingRef.current = false;
      if (!streamActiveRef.current) setSpeaking(false); // stream ended + queue drained
      return;
    }
    if (!streamPlayingRef.current && streamStartedAtRef.current) {
      debugLog(`TTS: time-to-first-audio ${Date.now() - streamStartedAtRef.current}ms`);
      streamStartedAtRef.current = 0;
    }
    streamPlayingRef.current = true;
    const utter = makeUtterance(next);
    currentChunkRef.current = next;
    spokenPartialRef.current = "";
    // Fires per word/sentence boundary as audio plays, so charIndex is how much
    // of this chunk has actually reached the speaker.
    utter.onboundary = (e) => {
      markBoundary();
      const idx = (e as SpeechSynthesisEvent).charIndex;
      if (typeof idx === "number" && idx > 0) spokenPartialRef.current = next.slice(0, idx);
    };
    utter.onend = () => {
      // A hold cancels this utterance, and some engines report that as an
      // ordinary end. It wasn't heard to the end, and hold() has already put
      // the unheard rest back on the queue.
      if (heldRef.current) return;
      spokenDoneRef.current.push(next); // whole chunk was heard
      spokenPartialRef.current = "";
      playNextRef.current();
    };
    utter.onerror = (e) => {
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err === "canceled" || err === "interrupted") return;
      playNextRef.current(); // skip the failed chunk, keep going
    };
    synth.resume();
    synth.speak(utter);
  };

  /** Begin a streamed reply — clears anything in flight and marks us speaking. */
  const streamReset = useCallback(() => {
    if (!supported || !enabled) return;
    speakTokenRef.current++;
    window.speechSynthesis.cancel();
    streamQueueRef.current = [];
    streamPosRef.current = 0;
    streamActiveRef.current = true;
    streamPlayingRef.current = false;
    heldRef.current = false;
    streamStartedAtRef.current = Date.now();
    resetSpoken(); // a new reply starts with nothing heard yet
    resetPulse();
    setSpeaking(true);
  }, [supported, enabled, resetSpoken]);

  /** Feed the accumulated reply text so far; speaks any newly-complete sentences. */
  const streamPush = useCallback(
    (full: string) => {
      if (!supported || !enabled || !streamActiveRef.current) return;
      const cleaned = cleanForSpeech(full);
      const rest = cleaned.slice(streamPosRef.current);
      // Sentence terminators across scripts: Latin, Devanagari danda, CJK, Arabic.
      const re = /[^.!?…。！？؟।॥]*[.!?…。！？؟।॥]+(?:\s+|$)/g;
      let m: RegExpExecArray | null;
      let consumed = 0;
      const out: string[] = [];
      while ((m = re.exec(rest)) !== null) {
        const s = m[0].trim();
        if (s) out.push(s);
        consumed = re.lastIndex;
      }
      if (out.length) {
        streamPosRef.current += consumed;
        streamQueueRef.current.push(...out);
        if (!streamPlayingRef.current) playNextRef.current();
        return;
      }
      // Nothing has been spoken yet and the reply's first sentence is still
      // being generated. Waiting for its terminator is dead air the user hears
      // as lag, so cut the opening clause and start talking over the rest of
      // the stream. Only the opener is split this way — once audio is playing,
      // later chunks stay whole sentences for natural prosody.
      if (streamPosRef.current === 0 && !streamPlayingRef.current) {
        const opener = openingClause(rest);
        if (opener) {
          streamPosRef.current += opener.length;
          streamQueueRef.current.push(opener.trim());
          playNextRef.current();
        }
      }
    },
    [supported, enabled],
  );

  /** Finish the stream — flush the trailing partial sentence and stop when drained. */
  const streamEnd = useCallback(
    (full: string) => {
      if (!supported) return;
      streamActiveRef.current = false;
      if (enabled) {
        const tail = cleanForSpeech(full).slice(streamPosRef.current).trim();
        if (tail) streamQueueRef.current.push(tail);
      }
      if (!streamPlayingRef.current) {
        if (streamQueueRef.current.length) playNextRef.current();
        else setSpeaking(false);
      }
    },
    [supported, enabled],
  );

  const selectVoice = useCallback((name: string | null) => {
    if (supported) window.speechSynthesis.cancel();
    speakTokenRef.current++;
    setSelectedVoice(name);
    if (typeof window !== "undefined") {
      if (name) localStorage.setItem(SELECTED_VOICE_KEY, name);
      else localStorage.removeItem(SELECTED_VOICE_KEY);
    }
  }, [supported]);

  return {
    speak,
    cancel,
    unlock,
    test,
    previewVoice,
    streamReset,
    streamPush,
    streamEnd,
    hold,
    release,
    held,
    getSpokenText,
    getSpeechPulse,
    enabled,
    setEnabled,
    speaking,
    voiceName: voice?.name ?? null,
    voices,
    selectedVoice,
    selectVoice,
    supported,
  };
}
