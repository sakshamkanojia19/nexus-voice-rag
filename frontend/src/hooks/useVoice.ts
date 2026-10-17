import { useCallback, useEffect, useRef, useState } from "react";
import { config, debugLog } from "@/lib/config";
import { transcribe } from "@/lib/api";
import {
  NOISE_FLOOR_INIT,
  frameRms,
  judgeLoudness,
  updateNoiseFloor,
} from "@/lib/voice-gate";
import {
  ENDPOINT_COMPLETE_MS,
  ENDPOINT_CONTINUING_MS,
  MAX_CONSECUTIVE_HOLDS,
  MAX_TURN_MS,
  cleanTranscript,
  isOnlyFiller,
  judgeEndpoint,
} from "@/lib/endpointing";
import {
  type ProsodyContour,
  createProsodyState,
  judgeProsody,
  observeFrame,
  resetProsody,
} from "@/lib/prosody";

// ---------------------------------------------------------------------------
// Web Speech API typings (browsers ship these as `webkitSpeechRecognition`)
// ---------------------------------------------------------------------------
interface SpeechRecognitionResultAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultSlot {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionResultAlternative;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResultSlot;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
    webkitAudioContext?: typeof AudioContext;
  }
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
/** Where the Silero model, audio worklet and ONNX-runtime wasm are served from
 *  (`frontend/public/vad/`). Must end in a slash — vad-web concatenates
 *  filenames directly onto it. Same-origin, so no CDN round trip and no
 *  version skew between vad-web and onnxruntime-web. */
const VAD_ASSET_PATH = "/vad/";

/** Silero v5 rather than vad-web's `legacy` default. v5 separates speech from
 *  steady background noise (fans, traffic, keyboard, distant TV) far more
 *  sharply, and runs on 512-sample frames instead of 1536 — 32ms of decision
 *  latency per frame instead of 96ms. `silero_vad_v5.onnx` is already served
 *  from VAD_ASSET_PATH, so this costs nothing extra to fetch. */
const VAD_MODEL = "v5" as const;

/** Probability thresholds while the assistant is silent. Deliberately above
 *  vad-web's 0.3/0.25 defaults: a false speech-start costs a wasted turn and a
 *  spurious barge-in, a slightly-late speech-start costs a few tens of ms. */
const VAD_POSITIVE_OPEN = 0.6;
const VAD_NEGATIVE_OPEN = 0.4;

/** Thresholds while the assistant's audio may be reaching the mic. Speaker echo
 *  that survives browser AEC is quiet and smeared, and scores well below clean
 *  nearby speech — raising the bar here rejects it acoustically instead of
 *  letting it run the whole STT pipeline and be discarded at the end. */
const VAD_POSITIVE_GUARDED = 0.85;
const VAD_NEGATIVE_GUARDED = 0.6;

/** Frame-count-derived options. These are computed once inside vad-web's
 *  FrameProcessor constructor, so — unlike the two thresholds above — they
 *  CANNOT be changed later via `setOptions()`. Anything tuned per-turn has to
 *  be a threshold. */
const VAD_MIN_SPEECH_MS = 280;
/**
 * Trailing silence before VAD closes a *segment*.
 *
 * This is no longer the turn-end decision — `@/lib/endpointing` makes that from
 * the words, and a segment ending here only starts its clock. So this wants to
 * be short: it is the granularity at which we get to re-evaluate whether the
 * sentence sounds finished, and a long value would delay even an obviously
 * complete question. The old 480ms *was* the turn end, which is why pausing to
 * think got you cut off half a second later.
 */
const VAD_REDEMPTION_MS = 420;
/**
 * Audio kept from before speech was detected. Generous on purpose: a segment
 * that begins a word late loses its first consonant, and Whisper guesses. That
 * guess is one of the ways a question comes back subtly wrong.
 */
const VAD_PRE_SPEECH_PAD_MS = 400;
/**
 * Sample rate of the frames handed to `onFrameProcessed`. The library resamples
 * whatever the microphone gives us to 16 kHz for the model, so this is fixed
 * regardless of the AudioContext's own rate — and the pitch tracker needs the
 * real figure, not `ctx.sampleRate`, or every frequency it reports is scaled
 * by the ratio between the two.
 */
const VAD_FRAME_SAMPLE_RATE = 16_000;

// Loudness gating (adaptive noise floor + SNR) lives in `@/lib/voice-gate`.
// Intonation analysis (pitch contour → turn-end cue) lives in `@/lib/prosody`.

// ── Web Speech session management ──────────────────────────────────────────
/** How long Web Speech text must sit unchanged before we finalize a turn without
 *  waiting on VAD. This is pure dead air at the end of every utterance on that
 *  path, so it's kept just above a natural mid-sentence pause. */
const WEB_SPEECH_IDLE_MS = 600;
/** Shorter wait once the recognizer has promoted the phrase to `isFinal` with no
 *  interim text trailing it: its endpointer has already spent its own silence
 *  window deciding the phrase ended, so repeating that wait is pure lag. Not
 *  zero — Chrome sometimes finalizes mid-utterance and resumes. */
const WEB_SPEECH_FINAL_MS = 250;
/** Restart backoff after the recognizer dies. Chrome's Web Speech is a hosted
 *  service; on a flaky connection it emits `network` and ends immediately, and
 *  an unconditional restart becomes a tight loop that starves the main thread. */
const WEB_SPEECH_RESTART_MIN_MS = 250;
const WEB_SPEECH_RESTART_MAX_MS = 4000;
/** Consecutive hard failures before Web Speech is abandoned for the rest of the
 *  session and the Whisper path takes over cleanly. */
const WEB_SPEECH_MAX_FAILURES = 4;

// ── Barge-in gating ────────────────────────────────────────────────────────
// Mirrors LiveKit's min_duration / min_words interruption options. VAD alone
// over-triggers on clicks, breaths and speaker echo, so a candidate must be both
// long enough and word-bearing before it is allowed to interrupt the assistant.
const MIN_INTERRUPTION_MS = 500;
const MIN_INTERRUPTION_WORDS = 1;
/** Classify a live candidate at most this often. Every classification can pause
 *  or resume speechSynthesis, and Chrome renders rapid pause/resume as audible
 *  stuttering — so this is a playback-quality limit, not just a CPU one. */
const CANDIDATE_MIN_INTERVAL_MS = 260;
/** Once a candidate is judged echo the verdict is latched for the utterance.
 *  Real speech starting mid-echo still breaks through, but only if the
 *  transcript grows by this many words beyond what was already dismissed. */
const ECHO_RELATCH_WORDS = 3;

/** How long `getLevel()` takes to fall to zero once frames stop arriving. */
const LEVEL_DECAY_MS = 200;

/** Whisper is skipped below this; a shorter clip is a click or a breath. */
const MIN_WHISPER_BLOB_BYTES = 1200;
/** Fallback turn cap when VAD is unavailable and nothing else can close a turn. */
const NO_VAD_TURN_CAP_MS = 12_000;
/** Quiet period after a capture failure before the mic may be reopened. */
const SESSION_RETRY_COOLDOWN_MS = 1500;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Common Whisper / Web Speech hallucinations produced when the model hears
// silence or background noise. We drop transcripts that match these.
const HALLUCINATION_PHRASES: RegExp[] = [
  /^thanks?\s+for\s+watching[!.]?$/i,
  /^thank\s+you[.!]?$/i,
  /^thanks[.!]?$/i,
  /^bye[-\s]?bye[.!]?$/i,
  /^bye[.!]?$/i,
  /^goodbye[.!]?$/i,
  /^subscribe[.!]?$/i,
  /^(?:please\s+)?(?:like\s+(?:and|&)\s+)?subscribe\s+(?:to\s+)?(?:my\s+|the\s+)?channel[.!]?$/i,
  /^\[music\]$/i,
  /^\[applause\]$/i,
  /^\[silence\]$/i,
  /^\[blank_audio\]$/i,
  /^okay[.!]?$/i,
  /^ok[.!]?$/i,
  /^you[.!]?$/i,
  /^\.+$/,
];

/** True if the transcript is almost certainly Whisper noise/hallucination. */
function isLikelyHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 3) return true;
  if (HALLUCINATION_PHRASES.some((re) => re.test(t))) return true;
  const stripped = t.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (stripped.length < 3) return true;
  return false;
}

/**
 * Whisper has a known failure mode where it echoes the `prompt` parameter
 * back as the transcript when the audio is silent / too noisy / too short.
 * Detect by checking if the transcript is dominated by tokens from the prompt.
 */
function isPromptEcho(transcript: string, prompt: string): boolean {
  const p = prompt.trim();
  if (!p) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const t = norm(transcript);
  const np = norm(p);
  if (!t) return true;
  // Exact / substring match — clear echo.
  if (t === np || np.includes(t) || t.includes(np)) return true;
  // Token-overlap heuristic: if >=70% of the transcript's tokens come from the
  // prompt and the transcript is short-ish, it's probably an echo.
  const tTokens = t.split(" ").filter(Boolean);
  if (tTokens.length === 0) return true;
  const pTokenSet = new Set(np.split(" ").filter(Boolean));
  const overlap = tTokens.filter((tok) => pTokenSet.has(tok)).length;
  return overlap / tTokens.length >= 0.7 && tTokens.length <= 20;
}

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/**
 * Concatenate the speech segments of one turn, with a short silence between
 * them where the speaker paused.
 *
 * The silence is not padding for its own sake: butt-joining two clips creates a
 * discontinuity that Whisper often reads as a word boundary in the wrong place,
 * or as a clipped consonant. A brief gap reproduces the pause that was actually
 * there and transcribes closer to what was said.
 */
const SEGMENT_GAP_MS = 120;

function joinSegments(segments: Float32Array[], sampleRate = 16_000): Float32Array {
  if (segments.length === 1) return segments[0] as Float32Array;
  const gap = Math.round((SEGMENT_GAP_MS / 1000) * sampleRate);
  const total = segments.reduce((n, s) => n + s.length, 0) + gap * Math.max(0, segments.length - 1);
  const out = new Float32Array(total);
  let offset = 0;
  segments.forEach((segment, i) => {
    out.set(segment, offset);
    offset += segment.length + (i < segments.length - 1 ? gap : 0);
  });
  return out;
}

/**
 * Identity of a turn's audio so far, cheap enough to compute per segment.
 * Used to decide whether a speculative Whisper result still describes the
 * audio actually being submitted — if the user spoke again, the segment count
 * or total sample length changed and the stale result must be discarded.
 */
function segmentsFingerprint(segments: Float32Array[]): string {
  return `${segments.length}:${segments.reduce((n, s) => n + s.length, 0)}`;
}

/** Encode vad-web's 16 kHz mono Float32 segment as a standards-compliant PCM
 * WAV file. This avoids slicing MediaRecorder/WebM containers mid-stream. */
function speechSegmentToWav(samples: Float32Array, sampleRate = 16_000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

type VadModule = typeof import("@ricky0123/vad-web");
type AudioNodeVADInstance = Awaited<ReturnType<VadModule["AudioNodeVAD"]["new"]>>;

let vadModulePromise: Promise<VadModule> | null = null;

/** Code-split import of vad-web. Vite bundles the JS; the model, worklet and
 *  ONNX wasm are fetched from VAD_ASSET_PATH at construction time. */
function ensureVADLib(): Promise<VadModule> {
  if (!vadModulePromise) vadModulePromise = import("@ricky0123/vad-web");
  return vadModulePromise;
}

/**
 * Warm the VAD chunk during idle time so the first mic press doesn't pay the
 * download. Failures are ignored — the session open retries the import and falls
 * back to a timer cap if it still can't load.
 */
export function prefetchVoiceAssets(): void {
  if (typeof window === "undefined") return;
  const run = (): void => {
    void ensureVADLib().catch((e) => debugLog("VAD prefetch failed (non-fatal)", e));
  };
  const ric = window.requestIdleCallback;
  if (typeof ric === "function") ric(run, { timeout: 3000 });
  else window.setTimeout(run, 1200);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export type VoiceState = "idle" | "listening" | "transcribing" | "error";

export interface UseVoiceOptions {
  lang?: string;
  mode?: "auto" | "webspeech" | "whisper";
  onTranscript: (text: string) => void;
  /** Classify live STT while the assistant may be audible. */
  onSpeechCandidate?: (transcript: string) => "echo" | "interrupt" | "accept" | void;
  /**
   * VAD has heard sustained, confirmed speech while the assistant was audible,
   * and no transcript exists yet to classify it. On the Whisper path this is
   * the ONLY early barge-in signal there is — text arrives seconds later, after
   * the endpointer and a transcription round trip. The app should treat it as
   * a candidate interruption (pause playback, pending confirmation), exactly
   * like an interim `onSpeechCandidate` verdict of "interrupt".
   */
  onAcousticBargeIn?: () => void;
  /**
   * Last chance to rescue a transcript the echo latch is about to discard.
   * Given the raw text, returns whatever of it was actually the USER — or ""
   * when the whole thing was our own reply coming back through the speakers.
   * Lives in the app because only it knows what the assistant just said.
   */
  salvageEcho?: (transcript: string) => string;
  /**
   * True while the assistant's own audio may be reaching the mic. Drives the
   * acoustic guard (stricter VAD thresholds) and suppresses the Whisper round
   * trip for audio that is almost certainly speaker echo.
   */
  isAssistantAudible?: () => boolean;
  /**
   * True during a live hands-free call, where the microphone is held open for
   * the whole conversation and each turn is just an arm/disarm of the existing
   * pipeline. False for push-to-talk from the composer, where the mic must be
   * released as soon as the single turn completes.
   */
  continuous?: boolean;
  whisperPrompt?: string;
  onError?: (message: string) => void;
}

export interface UseVoiceReturn {
  state: VoiceState;
  interim: string;
  start: () => Promise<void>;
  /** Stop capture and discard buffered audio without submitting a turn. */
  cancel: () => void;
  stop: () => void;
  toggle: () => Promise<void>;
  supported: boolean;
  /** Current mic input loudness, 0..1, sampled live while listening (else 0). */
  getLevel: () => number;
  /**
   * True while the user has paused but the turn is being held open because what
   * they said isn't finished. Lets the UI show that it is still listening
   * rather than appearing to have missed the pause.
   */
  holdingForSpeech: boolean;
}

export function useVoice(opts: UseVoiceOptions): UseVoiceReturn {
  const lang = opts.lang ?? config.defaultLang;
  const mode = opts.mode ?? config.sttMode;

  const [state, setState] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");

  // Callback refs — the listeners below outlive any single render.
  const onSpeechCandidateRef = useRef(opts.onSpeechCandidate);
  onSpeechCandidateRef.current = opts.onSpeechCandidate;
  const onAcousticBargeInRef = useRef(opts.onAcousticBargeIn);
  onAcousticBargeInRef.current = opts.onAcousticBargeIn;
  const salvageEchoRef = useRef(opts.salvageEcho);
  salvageEchoRef.current = opts.salvageEcho;
  const onTranscriptRef = useRef(opts.onTranscript);
  onTranscriptRef.current = opts.onTranscript;
  const isAssistantAudibleRef = useRef(opts.isAssistantAudible);
  isAssistantAudibleRef.current = opts.isAssistantAudible;
  const whisperPromptRef = useRef(opts.whisperPrompt);
  whisperPromptRef.current = opts.whisperPrompt;
  const continuousRef = useRef(opts.continuous ?? false);
  continuousRef.current = opts.continuous ?? false;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  // ── Session state (hardware; lives across turns) ──────────────────────────
  // Opening the mic means getUserMedia + a fresh AudioContext + an AudioWorklet
  // + an ONNX InferenceSession. Doing that per turn left the mic genuinely deaf
  // for hundreds of milliseconds between every exchange, which is what made the
  // call feel like it was hanging. The session is now opened once and only torn
  // down when the call ends.
  const streamRef = useRef<MediaStream | null>(null);
  // We drive vad-web through AudioNodeVAD with an AudioContext we create, rather
  // than MicVAD which hides its own. Owning the context matters once it outlives
  // a turn: browsers suspend contexts (backgrounded tab, audio device change),
  // and a suspended context delivers no frames — a mic that looks open and hears
  // nothing. It also removes the getStream/pauseStream shims MicVAD needed to
  // stop it from grabbing and closing a second capture of the same device.
  const vadCtxRef = useRef<AudioContext | null>(null);
  const vadNodeRef = useRef<AudioNodeVADInstance | null>(null);
  const vadSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** Deduplicates concurrent open attempts and lets late async work detect that
   *  it belongs to a session that has since been closed. */
  const sessionPromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionGenerationRef = useRef(0);
  /** Set once VAD has failed to load for this session — the turn falls back to
   *  MediaRecorder plus a timer cap instead of retrying the import each turn. */
  const vadUnavailableRef = useRef(false);
  /**
   * Earliest time a new session may be opened after a failure. A live call
   * re-arms the mic as soon as it goes idle, so without this a permanently
   * denied or unplugged microphone becomes a getUserMedia retry loop.
   */
  const sessionCooldownUntilRef = useRef(0);

  // ── Turn state (reset for every utterance) ────────────────────────────────
  const listeningRef = useRef(false);
  const turnGenerationRef = useRef(0);
  const recordedRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const vadAudioRef = useRef<Blob | null>(null);
  const finalTextRef = useRef("");
  const liveTextRef = useRef("");
  const webSpeechWorkedRef = useRef(false);
  /** True once the recognizer promoted the CURRENT utterance to a final result.
   *  Must be cleared per turn: leaving it latched makes every later utterance
   *  finalize on the short 250ms timer, truncating mid-sentence. */
  const sawWebSpeechFinalRef = useRef(false);
  const bargeInHandledRef = useRef(false);
  const assistantEchoRef = useRef(false);
  const vadSpeakingRef = useRef(false);
  /** When the current utterance began — VAD real-speech-start, or the first
   *  interim transcript if VAD never opened a segment. Drives MIN_INTERRUPTION_MS. */
  const utteranceStartAtRef = useRef(0);
  const speechResultTimerRef = useRef<number | null>(null);
  // ── Endpointing (one turn may span several pauses) ────────────────────────
  // A turn is no longer one VAD segment. When the user stops speaking we start
  // a window sized by how finished the sentence sounds; if they resume inside
  // it, the segments join into a single utterance. That is what lets someone
  // pause mid-thought without being cut off.
  /** Audio segments collected so far for THIS turn, joined on finalize. */
  const segmentsRef = useRef<Float32Array[]>([]);
  const endpointTimerRef = useRef<number | null>(null);
  // ── Speculative transcription ─────────────────────────────────────────────
  // On the Whisper path the endpoint hold (700–1600ms of deliberate silence)
  // and the transcription round trip used to run back-to-back, so the user
  // paid for both in full. Starting Whisper the moment a segment closes lets
  // the decode run DURING the hold; by the time the endpointer commits, most
  // or all of the transcription work is already done. If the user resumes
  // speaking the result no longer matches the turn's audio (see
  // `segmentsFingerprint`) and is simply dropped — a wasted decode, never a
  // wrong transcript.
  const speculativeKeyRef = useRef("");
  /** Resolves to the transcript, or null when the request failed (a fresh
   *  non-speculative request is then made — failure here must not fail the turn). */
  const speculativePromiseRef = useRef<Promise<string | null> | null>(null);
  /** When the turn's first confirmed speech began — bounds the total hold. */
  const turnStartedAtRef = useRef(0);
  /** How many times this turn has already been held open. */
  const holdCountRef = useRef(0);
  /** True while we are waiting out a thinking pause, for the UI. */
  const [holdingForSpeech, setHoldingForSpeech] = useState(false);
  const considerEndpointRef = useRef<() => void>(() => {});
  const fallbackTimerRef = useRef<number | null>(null);
  /** Pending "has this speech-over-playback lasted long enough to count as a
   *  barge-in?" check — see `onSpeechRealStart`. */
  const acousticBargeInTimerRef = useRef<number | null>(null);
  /** Whether this utterance already raised an acoustic barge-in candidate — i.e.
   *  speech that outlasted MIN_INTERRUPTION_MS against the *guarded* VAD
   *  threshold while our own reply was audible, and that paused playback on the
   *  strength of it. Positive evidence a human is talking, and the finalizer
   *  needs it: without it, silence from a slow recognizer reads as echo. */
  const acousticBargeInRaisedRef = useRef(false);
  /**
   * Web Speech emits a result per word as you speak. Classifying each one
   * pauses/resumes speechSynthesis, which Chrome renders as audible stutter, so
   * candidates are rate-limited and an "echo" verdict is latched.
   */
  const lastCandidateAtRef = useRef(0);
  const lastCandidateTextRef = useRef("");
  const echoLatchedWordsRef = useRef(0);
  /**
   * How far into the recognizer's cumulative `results` list this session has
   * already consumed. The recognizer now outlives a single turn, so its list
   * keeps growing between turns; without this, text finalized while we were
   * disarmed could be replayed into the next turn.
   */
  const consumedResultIndexRef = useRef(0);
  /** Highest `results.length` the recognizer has reported, so arming a turn can
   *  discard any interim still pending from the utterance that just ended. */
  const lastSeenResultCountRef = useRef(0);

  // ── Loudness / noise floor ────────────────────────────────────────────────
  const noiseFloorRef = useRef(NOISE_FLOOR_INIT);
  const utterancePeakRmsRef = useRef(0);

  // ── Intonation ────────────────────────────────────────────────────────────
  /** Pitch contour of the segment currently being spoken. */
  const prosodyRef = useRef(createProsodyState());
  /**
   * The verdict for the segment that most recently ended, held separately
   * because `prosodyRef` is cleared the moment the next segment starts. This is
   * what the endpointer reads.
   */
  const prosodyContourRef = useRef<ProsodyContour>("unknown");
  const levelRef = useRef(0);
  const levelAtRef = useRef(0);
  /** Analyser fallback, used only when VAD is unavailable — otherwise the level
   *  is read from VAD frames we are already computing. */
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterRafRef = useRef<number | null>(null);

  // ── Web Speech restart backoff ────────────────────────────────────────────
  const webSpeechFailuresRef = useRef(0);
  const webSpeechDisabledRef = useRef(false);
  const webSpeechRestartTimerRef = useRef<number | null>(null);
  /** Restarts since the recognizer last produced anything. Chrome can end a
   *  session without ever raising `onerror`; without this, that path would
   *  restart at zero delay forever. */
  const restartsWithoutResultRef = useRef(0);

  const finishAndSendRef = useRef<() => void>(() => {});
  const armTurnRef = useRef<() => void>(() => {});

  const SR: SpeechRecognitionCtor | undefined =
    typeof window !== "undefined"
      ? window.SpeechRecognition ?? window.webkitSpeechRecognition
      : undefined;

  const assistantAudible = useCallback(
    (): boolean => isAssistantAudibleRef.current?.() === true,
    [],
  );

  const clearTimer = (ref: React.MutableRefObject<number | null>): void => {
    if (ref.current !== null) {
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  };

  // ── Metering ──────────────────────────────────────────────────────────────
  const noteLevel = useCallback((rms: number) => {
    // Smooth + scale so quiet speech still moves the visual.
    levelRef.current = levelRef.current * 0.6 + Math.min(1, rms * 3.2) * 0.4;
    levelAtRef.current = Date.now();
  }, []);

  const stopAnalyserMetering = useCallback(() => {
    if (meterRafRef.current != null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    if (meterCtxRef.current) {
      try { void meterCtxRef.current.close(); } catch {/* noop */}
      meterCtxRef.current = null;
    }
  }, []);

  /** Only used when VAD can't run. With VAD active the frame callback already
   *  gives us 16 kHz mono RMS, so a second AudioContext would be pure waste. */
  const startAnalyserMetering = useCallback((stream: MediaStream) => {
    if (meterCtxRef.current) return;
    try {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      meterCtxRef.current = ctx;
      const tick = (): void => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = ((data[i] ?? 128) - 128) / 128;
          sum += v * v;
        }
        noteLevel(Math.sqrt(sum / data.length));
        meterRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      debugLog("audio metering unavailable", e);
    }
  }, [noteLevel]);

  // ── Per-turn bookkeeping ──────────────────────────────────────────────────
  const resetTurnState = useCallback(() => {
    recordedRef.current = [];
    vadAudioRef.current = null;
    finalTextRef.current = "";
    liveTextRef.current = "";
    webSpeechWorkedRef.current = false;
    sawWebSpeechFinalRef.current = false;
    bargeInHandledRef.current = false;
    assistantEchoRef.current = false;
    vadSpeakingRef.current = false;
    utteranceStartAtRef.current = 0;
    utterancePeakRmsRef.current = 0;
    resetProsody(prosodyRef.current);
    prosodyContourRef.current = "unknown";
    lastCandidateAtRef.current = 0;
    lastCandidateTextRef.current = "";
    echoLatchedWordsRef.current = 0;
    acousticBargeInRaisedRef.current = false;
    segmentsRef.current = [];
    turnStartedAtRef.current = 0;
    holdCountRef.current = 0;
    speculativeKeyRef.current = "";
    speculativePromiseRef.current = null;
    setHoldingForSpeech(false);
    clearTimer(speechResultTimerRef);
    clearTimer(fallbackTimerRef);
    clearTimer(endpointTimerRef);
    clearTimer(acousticBargeInTimerRef);
  }, []);

  const stopRecorder = useCallback((): Promise<void> => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    return new Promise<void>((resolve) => {
      if (!recorder || recorder.state === "inactive") return resolve();
      recorder.onstop = () => resolve();
      try { recorder.stop(); } catch { resolve(); }
    });
  }, []);

  /** MediaRecorder is only the VAD-less fallback; with VAD running the WAV
   *  segment it hands us is both smaller and already trimmed to the utterance. */
  const startRecorder = useCallback((): boolean => {
    if (!streamRef.current || typeof MediaRecorder === "undefined") return false;
    if (recorderRef.current) return true;
    try {
      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(streamRef.current, { mimeType })
        : new MediaRecorder(streamRef.current);
      recordedRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) recordedRef.current.push(e.data);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      return true;
    } catch (e) {
      debugLog("MediaRecorder init failed", e);
      return false;
    }
  }, []);

  const closeSession = useCallback(() => {
    sessionGenerationRef.current++;
    sessionPromiseRef.current = null;
    listeningRef.current = false;
    vadUnavailableRef.current = false;
    webSpeechFailuresRef.current = 0;
    webSpeechDisabledRef.current = false;
    clearTimer(webSpeechRestartTimerRef);
    clearTimer(speechResultTimerRef);
    clearTimer(fallbackTimerRef);
    stopAnalyserMetering();
    levelRef.current = 0;
    levelAtRef.current = 0;
    noiseFloorRef.current = NOISE_FLOOR_INIT;

    if (recognitionRef.current) {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.abort();
      } catch {/* noop */}
    }
    if (vadNodeRef.current) {
      const node = vadNodeRef.current;
      vadNodeRef.current = null;
      try {
        node.pause();
        node.destroy();
      } catch {/* noop */}
    }
    if (vadSourceRef.current) {
      try { vadSourceRef.current.disconnect(); } catch {/* noop */}
      vadSourceRef.current = null;
    }
    if (vadCtxRef.current) {
      const ctx = vadCtxRef.current;
      vadCtxRef.current = null;
      void ctx.close().catch(() => {/* noop */});
    }
    if (recorderRef.current) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch {/* noop */}
      }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recordedRef.current = [];
    vadAudioRef.current = null;
  }, [stopAnalyserMetering]);

  const failWith = useCallback(
    (message: string) => {
      debugLog("voice error:", message);
      closeSession();
      resetTurnState();
      sessionCooldownUntilRef.current = Date.now() + SESSION_RETRY_COOLDOWN_MS;
      setState("error");
      setInterim("");
      onErrorRef.current?.(message);
      // Auto-reset to idle so the user can try again.
      window.setTimeout(() => setState((s) => (s === "error" ? "idle" : s)), 50);
    },
    [closeSession, resetTurnState],
  );

  // ── Web Speech ────────────────────────────────────────────────────────────
  /**
   * Feed a live transcript to the app's echo/barge-in classifier, rate-limited
   * and latched. Returns nothing; side effects land on the echo/barge-in refs.
   */
  const classifyCandidate = useCallback((text: string) => {
    if (!text || bargeInHandledRef.current) return;

    const words = wordCount(text);
    // An echo verdict stands for the rest of the utterance unless substantially
    // more speech arrives — that is what stops the resume/pause storm.
    if (assistantEchoRef.current && words < echoLatchedWordsRef.current + ECHO_RELATCH_WORDS) return;

    const utteranceMs = utteranceStartAtRef.current ? Date.now() - utteranceStartAtRef.current : 0;
    if (utteranceMs < MIN_INTERRUPTION_MS || words < MIN_INTERRUPTION_WORDS) return;

    const now = Date.now();
    if (text === lastCandidateTextRef.current) return;
    if (now - lastCandidateAtRef.current < CANDIDATE_MIN_INTERVAL_MS) return;
    lastCandidateAtRef.current = now;
    lastCandidateTextRef.current = text;

    const decision = onSpeechCandidateRef.current?.(text);
    if (decision === "echo") {
      assistantEchoRef.current = true;
      echoLatchedWordsRef.current = words;
    } else if (decision === "interrupt") {
      bargeInHandledRef.current = true;
      assistantEchoRef.current = false;
      debugLog("STT confirmed barge-in:", text);
    }
  }, []);

  const scheduleWebSpeechRestart = useCallback(() => {
    if (webSpeechDisabledRef.current || !streamRef.current) return;
    if (webSpeechRestartTimerRef.current !== null) return;
    // Back off on whichever signal is worse: explicit errors, or silent restarts
    // that never produced a result. A healthy idle-timeout restart is attempt 0
    // and resumes instantly.
    const attempt = Math.max(webSpeechFailuresRef.current, restartsWithoutResultRef.current);
    restartsWithoutResultRef.current++;
    const delay = attempt === 0
      ? 0
      : Math.min(WEB_SPEECH_RESTART_MIN_MS * 2 ** (attempt - 1), WEB_SPEECH_RESTART_MAX_MS);
    const generation = sessionGenerationRef.current;
    webSpeechRestartTimerRef.current = window.setTimeout(() => {
      webSpeechRestartTimerRef.current = null;
      if (generation !== sessionGenerationRef.current) return;
      const recognition = recognitionRef.current;
      if (!recognition || webSpeechDisabledRef.current) return;
      try {
        recognition.start();
      } catch (e) {
        // `InvalidStateError` just means it was already running — harmless.
        debugLog("Web Speech restart skipped", e);
      }
    }, delay);
  }, []);

  const startWebSpeech = useCallback((): boolean => {
    if (!SR || webSpeechDisabledRef.current) return false;
    try {
      const recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = lang;
      // A fresh recognizer starts a fresh `results` list.
      consumedResultIndexRef.current = 0;
      lastSeenResultCountRef.current = 0;

      recognition.onresult = (e: SpeechRecognitionEvent) => {
        webSpeechFailuresRef.current = 0;
        restartsWithoutResultRef.current = 0;
        lastSeenResultCountRef.current = Math.max(lastSeenResultCountRef.current, e.results.length);
        // The recognizer stays alive across turns, so anything it decoded while
        // we were disarmed belongs to no turn — skip past it rather than letting
        // it surface in the next one.
        if (!listeningRef.current) {
          consumedResultIndexRef.current = e.results.length;
          return;
        }
        webSpeechWorkedRef.current = true;

        let finalDelta = "";
        let interimPart = "";
        let consumed = consumedResultIndexRef.current;
        for (let i = Math.max(e.resultIndex, consumed); i < e.results.length; i++) {
          const slot = e.results[i];
          if (!slot) continue;
          const text = slot[0]?.transcript ?? "";
          if (slot.isFinal) {
            finalDelta += text + " ";
            consumed = i + 1; // finals are immutable — never read this slot again
          } else {
            interimPart += text;
          }
        }
        consumedResultIndexRef.current = consumed;
        finalTextRef.current += finalDelta;
        // A final segment with nothing trailing means the recognizer's own
        // endpointer already decided the phrase was over — no need to re-run
        // that wait ourselves.
        if (finalDelta.trim() && !interimPart.trim()) sawWebSpeechFinalRef.current = true;
        else if (interimPart.trim()) sawWebSpeechFinalRef.current = false;

        liveTextRef.current = (finalTextRef.current + interimPart).trim();

        // Fallback clock for languages/browsers where Web Speech produces text
        // but acoustic VAD never opens a segment.
        if (!utteranceStartAtRef.current && liveTextRef.current) {
          utteranceStartAtRef.current = Date.now();
        }

        // VAD hears both a nearby user and assistant audio from the speakers.
        // Wait for actual words so the app can reject assistant echo before
        // cancelling the response.
        classifyCandidate(liveTextRef.current);

        // A live call shows no transcript, so publishing one would re-render the
        // whole tree once per recognised word — for text nothing displays, at
        // exactly the moment the visualizer needs its frames. Push-to-talk in
        // the composer does show it, and still gets every update.
        //
        // Web Speech also has no idea the assistant is talking, so it happily
        // decodes our own playback. Once a candidate is judged echo, keep it off
        // screen: it is discarded before submit anyway, and captioning the
        // assistant's words as the user's is the most visible symptom of leak.
        if (!continuousRef.current && (!assistantEchoRef.current || bargeInHandledRef.current)) {
          setInterim(liveTextRef.current);
        }

        // Some languages/browsers produce a good Web Speech transcript while
        // acoustic VAD never opens a speech segment. This clock covers that
        // case; it hands off to the endpointer rather than finalizing directly,
        // so text arriving without VAD still gets the same "are they actually
        // finished?" judgement instead of a flat timeout.
        clearTimer(speechResultTimerRef);
        speechResultTimerRef.current = window.setTimeout(() => {
          speechResultTimerRef.current = null;
          if (listeningRef.current && !vadSpeakingRef.current && liveTextRef.current.trim()) {
            debugLog("STT idle timeout: no VAD speech-end — asking the endpointer");
            considerEndpointRef.current();
          }
        }, sawWebSpeechFinalRef.current ? WEB_SPEECH_FINAL_MS : WEB_SPEECH_IDLE_MS);
      };

      recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
        debugLog("Web Speech error:", e.error);
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          webSpeechDisabledRef.current = true;
          failWith("Microphone access denied.");
          return;
        }
        // `no-speech` and `aborted` are ordinary lifecycle events, not failures —
        // counting them would disable a perfectly healthy recognizer.
        if (e.error === "no-speech" || e.error === "aborted") return;
        webSpeechFailuresRef.current++;
        if (webSpeechFailuresRef.current >= WEB_SPEECH_MAX_FAILURES) {
          webSpeechDisabledRef.current = true;
          debugLog(
            `Web Speech disabled for this session after ${webSpeechFailuresRef.current} failures — using Whisper`,
          );
          // Whisper needs container audio, and until now VAD alone was feeding
          // the pipeline. Bring the recorder up so the next turn still has audio.
          if (listeningRef.current) startRecorder();
        }
      };

      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return; // superseded / closed
        // Chrome ends continuous sessions on its own (idle timeout, transient
        // network loss). Restart with backoff rather than immediately — an
        // unconditional restart after a `network` error is a tight loop.
        scheduleWebSpeechRestart();
      };

      recognitionRef.current = recognition;
      recognition.start();
      return true;
    } catch (e) {
      debugLog("Web Speech start failed", e);
      recognitionRef.current = null;
      return false;
    }
  }, [SR, classifyCandidate, failWith, scheduleWebSpeechRestart, startRecorder, lang]);

  // ── VAD ───────────────────────────────────────────────────────────────────
  /** Tighten or relax the acoustic gate. Only the two probability thresholds are
   *  live-tunable in vad-web — the ms-derived options are frozen at construction. */
  const applyVadGuard = useCallback((guarded: boolean) => {
    const node = vadNodeRef.current;
    if (!node) return;
    try {
      node.setFrameProcessorOptions({
        positiveSpeechThreshold: guarded ? VAD_POSITIVE_GUARDED : VAD_POSITIVE_OPEN,
        negativeSpeechThreshold: guarded ? VAD_NEGATIVE_GUARDED : VAD_NEGATIVE_OPEN,
      });
    } catch (e) {
      debugLog("VAD setFrameProcessorOptions failed (non-fatal)", e);
    }
  }, []);

  /**
   * Was this segment loud enough, relative to the room, to be someone talking to
   * the app? Silero says "speech"; this says "speech that concerns us".
   */
  const passesLoudnessGate = useCallback((): boolean => {
    const verdict = judgeLoudness(utterancePeakRmsRef.current, noiseFloorRef.current);
    if (!verdict.accepted) {
      debugLog(`VAD: rejected — ${verdict.reason} (${verdict.detail})`);
      return false;
    }
    return true;
  }, []);

  const createVad = useCallback(async (stream: MediaStream, generation: number): Promise<boolean> => {
    let ctx: AudioContext | null = null;
    try {
      const { AudioNodeVAD } = await ensureVADLib();
      if (generation !== sessionGenerationRef.current) return false;

      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();

      const node = await AudioNodeVAD.new(ctx, {
        model: VAD_MODEL,
        baseAssetPath: VAD_ASSET_PATH,
        onnxWASMBasePath: VAD_ASSET_PATH,
        positiveSpeechThreshold: VAD_POSITIVE_OPEN,
        negativeSpeechThreshold: VAD_NEGATIVE_OPEN,
        redemptionMs: VAD_REDEMPTION_MS,
        preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
        minSpeechMs: VAD_MIN_SPEECH_MS,
        // Pausing between turns must never synthesise a speech-end event.
        submitUserSpeechOnPause: false,

        onFrameProcessed: (probs, frame) => {
          const rms = frameRms(frame);
          noteLevel(rms);
          if (vadSpeakingRef.current) {
            if (rms > utterancePeakRmsRef.current) utterancePeakRmsRef.current = rms;
            // Follow the speaker's pitch while they talk, so that when they stop
            // we already know whether their voice was landing or still rising.
            // Unvoiced frames are discarded inside `observeFrame`.
            observeFrame(prosodyRef.current, frame, VAD_FRAME_SAMPLE_RATE);
          } else if (probs.isSpeech < VAD_NEGATIVE_OPEN) {
            // Track ambient only on frames the model is confident are not speech.
            noiseFloorRef.current = updateNoiseFloor(noiseFloorRef.current, rms);
          }
        },

        onSpeechStart: () => {
          // Fires on the first positive frame, which is still often noise.
          // Treated as "maybe", not as the start of a turn.
          vadSpeakingRef.current = true;
          utterancePeakRmsRef.current = 0;
          // Each segment gets its own contour. Carrying the previous one over
          // would let a finished sentence's fall be read as the ending of the
          // fragment that follows it.
          resetProsody(prosodyRef.current);
          clearTimer(speechResultTimerRef);
          // The user resumed inside the thinking window: this is the same turn
          // continuing, so cancel the pending end rather than starting a new one.
          if (endpointTimerRef.current !== null) {
            debugLog("endpoint: user resumed — turn continues");
            clearTimer(endpointTimerRef);
            holdCountRef.current++;
            setHoldingForSpeech(false);
          }
        },

        onSpeechRealStart: () => {
          // Only fires once the segment has survived minSpeechMs of speech — the
          // right clock for barge-in, and the right moment to call it an utterance.
          utteranceStartAtRef.current = Date.now();
          if (!turnStartedAtRef.current) turnStartedAtRef.current = Date.now();
          debugLog("VAD: speech start (confirmed)");
          // Speech over our own playback, with no text to judge it by yet. Wait
          // out the remainder of MIN_INTERRUPTION_MS (the guarded 0.85 VAD
          // threshold has already filtered most speaker echo acoustically) and
          // if the speech is still going, surface it as a barge-in candidate so
          // playback can pause instead of talking over the user for the several
          // seconds the Whisper path needs to produce words.
          if (assistantAudible()) {
            clearTimer(acousticBargeInTimerRef);
            acousticBargeInTimerRef.current = window.setTimeout(() => {
              acousticBargeInTimerRef.current = null;
              if (listeningRef.current && vadSpeakingRef.current && assistantAudible()) {
                debugLog("VAD: sustained speech during playback — acoustic barge-in candidate");
                acousticBargeInRaisedRef.current = true;
                onAcousticBargeInRef.current?.();
              }
            }, Math.max(0, MIN_INTERRUPTION_MS - VAD_MIN_SPEECH_MS));
          }
        },

        onSpeechEnd: (audio) => {
          vadSpeakingRef.current = false;
          if (!listeningRef.current) return;
          if (!passesLoudnessGate()) {
            // Ambient noise that Silero liked. Drop the segment.
            vadAudioRef.current = null;
            utterancePeakRmsRef.current = 0;
            if (segmentsRef.current.length > 0 || endpointTimerRef.current !== null) {
              // Mid-turn: the user is part-way through and a fan just kicked in.
              // Discarding their words here is precisely the bug being fixed, so
              // keep the turn and let the endpointer carry on timing it.
              debugLog("VAD: noise during a turn — segment dropped, turn kept");
              return;
            }
            // Between turns: reset fully so the next utterance is judged clean.
            liveTextRef.current = "";
            finalTextRef.current = "";
            prosodyContourRef.current = "unknown";
            utteranceStartAtRef.current = 0;
            lastCandidateAtRef.current = 0;
            lastCandidateTextRef.current = "";
            echoLatchedWordsRef.current = 0;
            assistantEchoRef.current = false;
            consumedResultIndexRef.current = lastSeenResultCountRef.current;
            setInterim("");
            return;
          }
          // Read the contour now, while it belongs to the segment that just
          // ended — the next `onSpeechStart` clears it.
          prosodyContourRef.current = judgeProsody(prosodyRef.current);
          debugLog(`VAD: speech end (pitch ${prosodyContourRef.current})`);
          // Acoustic silence, not necessarily the end of the turn. Keep the
          // audio and let the endpointer decide whether the user is finished or
          // just thinking.
          segmentsRef.current.push(audio);
          considerEndpointRef.current();
        },

        onVADMisfire: () => {
          vadSpeakingRef.current = false;
          // A misfire is by definition a segment shorter than minSpeechMs — a
          // click, a breath, a door. It must never become a turn. (The old code
          // finalized here whenever any live text existed, which is exactly how
          // background noise got promoted into questions.)
          debugLog("VAD: misfire — ignored");
          vadAudioRef.current = null;
          // A misfire during a turn is usually the user's own breath or a lip
          // smack between words. `onSpeechStart` already cancelled the endpoint
          // timer on the way in, so restart the endpointer or the turn would
          // hang open with nothing left to close it.
          if (listeningRef.current && (liveTextRef.current.trim() || segmentsRef.current.length > 0)) {
            considerEndpointRef.current();
          }
        },
      });

      // The user may end or mute the call while the WASM model is still loading.
      // Never let late async initialization reopen a ghost mic.
      if (generation !== sessionGenerationRef.current || streamRef.current !== stream) {
        try { node.destroy(); } catch {/* noop */}
        void ctx.close().catch(() => {/* noop */});
        return false;
      }

      const source = ctx.createMediaStreamSource(stream);
      node.receive(source);
      vadCtxRef.current = ctx;
      vadNodeRef.current = node;
      vadSourceRef.current = source;
      return true;
    } catch (e) {
      debugLog("VAD unavailable", e);
      if (ctx) void ctx.close().catch(() => {/* noop */});
      return false;
    }
  }, [noteLevel, passesLoudnessGate]);

  // ── Session lifecycle ─────────────────────────────────────────────────────
  /**
   * Bring up the microphone, the VAD and the recognizer — once. Idempotent and
   * safe to call concurrently; every turn after the first is a no-op that
   * resolves immediately, which is the whole point.
   */
  const openSession = useCallback((): Promise<boolean> => {
    if (streamRef.current && (vadNodeRef.current || vadUnavailableRef.current)) {
      return Promise.resolve(true);
    }
    if (sessionPromiseRef.current) return sessionPromiseRef.current;
    if (Date.now() < sessionCooldownUntilRef.current) return Promise.resolve(false);

    const generation = ++sessionGenerationRef.current;
    const promise = (async (): Promise<boolean> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        failWith("Browser doesn't support microphone access.");
        return false;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch {
        failWith("Microphone access denied. Enable it in your browser site settings.");
        return false;
      }
      if (generation !== sessionGenerationRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      streamRef.current = stream;

      // A track ending under us (device unplugged, OS grabbed it) would
      // otherwise leave a session that looks open but is permanently silent.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (generation !== sessionGenerationRef.current) return;
          debugLog("microphone track ended — closing session");
          failWith("Microphone disconnected.");
        };
      });

      const wantWebSpeech = mode === "webspeech" || mode === "auto";
      const webSpeechStarted = wantWebSpeech ? startWebSpeech() : false;

      const vadStarted = await createVad(stream, generation);
      if (generation !== sessionGenerationRef.current) return false;

      if (!vadStarted) {
        vadUnavailableRef.current = true;
        // Without VAD there is no acoustic endpointing, so the turn needs
        // container audio for Whisper plus a hard cap to close it.
        startAnalyserMetering(stream);
        if (!startRecorder() && !webSpeechStarted) {
          failWith("No STT engine available in this browser.");
          return false;
        }
      } else if (mode === "whisper") {
        // Whisper-only mode never has Web Speech text to fall back on, so keep a
        // recorder alongside VAD in case a segment arrives without one.
        startRecorder();
      }
      return true;
    })();

    sessionPromiseRef.current = promise;
    void promise.finally(() => {
      if (sessionPromiseRef.current === promise) sessionPromiseRef.current = null;
    });
    return promise;
  }, [createVad, failWith, mode, startAnalyserMetering, startRecorder, startWebSpeech]);

  /** Begin accepting a new utterance on an already-open session. Cheap: no
   *  getUserMedia, no ONNX load, no new AudioContext. */
  const armTurn = useCallback(() => {
    turnGenerationRef.current++;
    resetTurnState();
    // A turn starts from whatever the recognizer has NOT yet reported. Anything
    // already in its list — including an interim still trailing the utterance we
    // just submitted — belongs to the previous turn.
    consumedResultIndexRef.current = lastSeenResultCountRef.current;
    listeningRef.current = true;
    setInterim("");
    setState("listening");

    applyVadGuard(assistantAudible());
    if (vadNodeRef.current) {
      // A context suspended while the tab was backgrounded delivers no frames.
      const ctx = vadCtxRef.current;
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {/* noop */});
      try { vadNodeRef.current.start(); } catch (e) { debugLog("VAD resume failed", e); }
    } else if (vadUnavailableRef.current) {
      startRecorder();
      clearTimer(fallbackTimerRef);
      fallbackTimerRef.current = window.setTimeout(() => {
        fallbackTimerRef.current = null;
        if (listeningRef.current) finishAndSendRef.current();
      }, NO_VAD_TURN_CAP_MS);
    }
    // Chrome sometimes ends a continuous session quietly; make sure one is live.
    if (recognitionRef.current === null && !webSpeechDisabledRef.current && (mode === "webspeech" || mode === "auto")) {
      startWebSpeech();
    }
  }, [applyVadGuard, assistantAudible, mode, resetTurnState, startRecorder, startWebSpeech]);
  armTurnRef.current = armTurn;

  /** Stop accepting audio for this turn, leaving the session open. */
  const disarmTurn = useCallback(() => {
    listeningRef.current = false;
    vadSpeakingRef.current = false;
    clearTimer(speechResultTimerRef);
    clearTimer(fallbackTimerRef);
    clearTimer(endpointTimerRef);
    clearTimer(acousticBargeInTimerRef);
    setHoldingForSpeech(false);
    if (vadNodeRef.current) {
      try { vadNodeRef.current.pause(); } catch (e) { debugLog("VAD pause failed", e); }
    }
  }, []);

  // ── Speculative transcription ─────────────────────────────────────────────
  /**
   * Begin transcribing the audio collected so far, without committing the turn.
   * Called when the endpointer starts a wait: the decode then overlaps the
   * silence the endpointer was going to spend anyway. Only meaningful on the
   * Whisper path — when Web Speech is delivering text, that text is the
   * transcript and no round trip exists to hide.
   */
  const beginSpeculativeTranscribe = useCallback(() => {
    if (!listeningRef.current) return;
    // Echo audio is discarded at finalize without ever reaching Whisper;
    // transcribing it here would spend the round trip the echo path exists to skip.
    if (assistantAudible() || (assistantEchoRef.current && !bargeInHandledRef.current)) return;
    const webSpeechText = (liveTextRef.current || finalTextRef.current).trim();
    if (mode === "webspeech") return;
    if (mode === "auto" && webSpeechWorkedRef.current && webSpeechText.length > 0) return;
    const segments = segmentsRef.current;
    if (segments.length === 0) return;
    const key = segmentsFingerprint(segments);
    if (speculativeKeyRef.current === key && speculativePromiseRef.current) return;
    const blob = speechSegmentToWav(joinSegments(segments.slice()));
    if (blob.size < MIN_WHISPER_BLOB_BYTES) return;
    speculativeKeyRef.current = key;
    speculativePromiseRef.current = transcribe(blob, whisperPromptRef.current ?? "", lang)
      .catch((e) => {
        debugLog("speculative transcribe failed (non-fatal)", e);
        return null;
      });
    debugLog("STT: speculative Whisper started during endpoint hold");
  }, [assistantAudible, lang, mode]);
  const beginSpeculativeTranscribeRef = useRef(beginSpeculativeTranscribe);
  beginSpeculativeTranscribeRef.current = beginSpeculativeTranscribe;

  // ── Endpointing ───────────────────────────────────────────────────────────
  /**
   * The user has gone quiet. Decide whether that was the end of the turn or a
   * pause for thought, and either finalize or keep the microphone open.
   *
   * This is what stops the assistant answering half a question. A fixed silence
   * threshold cannot distinguish "…what is the capital of" from "…what is the
   * capital of France?", so the decision is made from the words, not the clock.
   */
  const considerEndpoint = useCallback(() => {
    if (!listeningRef.current) return;
    clearTimer(endpointTimerRef);

    const heard = liveTextRef.current.trim();

    // Speaker echo is not a turn being composed, so it gets no thinking window.
    // Holding here would keep the mic tied up for seconds on our own voice and
    // delay the point at which a real user turn can start.
    if (assistantEchoRef.current && !bargeInHandledRef.current) {
      debugLog("endpoint: echo — finalizing immediately to discard");
      setHoldingForSpeech(false);
      finishAndSendRef.current();
      return;
    }

    // Nothing but hesitation so far — "um", a cough transcribed as "uh". There
    // is no turn here yet, so wait rather than submitting a filler as a question.
    if (heard && isOnlyFiller(heard)) {
      debugLog("endpoint: filler only — still waiting");
      liveTextRef.current = "";
      finalTextRef.current = "";
      consumedResultIndexRef.current = lastSeenResultCountRef.current;
      setHoldingForSpeech(true);
      endpointTimerRef.current = window.setTimeout(() => {
        endpointTimerRef.current = null;
        setHoldingForSpeech(false);
        // Still nothing after the window: drop the turn, don't submit "um".
        if (listeningRef.current && !liveTextRef.current.trim()) {
          debugLog("endpoint: nothing but filler — discarding");
          segmentsRef.current = [];
          turnStartedAtRef.current = 0;
          holdCountRef.current = 0;
        }
      }, ENDPOINT_CONTINUING_MS);
      return;
    }

    const decision = judgeEndpoint(heard, prosodyContourRef.current);
    const elapsed = turnStartedAtRef.current ? Date.now() - turnStartedAtRef.current : 0;

    // Two backstops, so a turn cannot be held open indefinitely by someone who
    // keeps trailing off: total length, and number of consecutive holds.
    const exhausted =
      elapsed >= MAX_TURN_MS || holdCountRef.current >= MAX_CONSECUTIVE_HOLDS;

    if (decision.completeness === "complete" || exhausted) {
      debugLog(
        `endpoint: finalizing after ${decision.waitMs}ms — ${exhausted ? "turn budget spent" : decision.reason}`,
      );
      setHoldingForSpeech(false);
      // The wait is now also decode time: Whisper works through the audio while
      // the endpointer waits out the silence, instead of starting after it.
      beginSpeculativeTranscribeRef.current();
      endpointTimerRef.current = window.setTimeout(() => {
        endpointTimerRef.current = null;
        finishAndSendRef.current();
      }, exhausted ? ENDPOINT_COMPLETE_MS : decision.waitMs);
      return;
    }

    // Unfinished. Hold the microphone open — `onSpeechStart` cancels this timer
    // if the user resumes, which is what joins the fragments into one turn.
    debugLog(`endpoint: holding ${decision.waitMs}ms — ${decision.reason}`);
    setHoldingForSpeech(true);
    // Worth starting even though the user may resume: if they do, the result is
    // dropped by the fingerprint check; if they don't, the whole hold window was
    // decode time. On the GPU a wasted short decode costs almost nothing.
    beginSpeculativeTranscribeRef.current();
    const holdTimer = window.setTimeout(() => {
      endpointTimerRef.current = null;
      setHoldingForSpeech(false);
      debugLog("endpoint: thinking window elapsed — finalizing");
      finishAndSendRef.current();
    }, decision.waitMs);
    endpointTimerRef.current = holdTimer;

    // With no live text (Web Speech down or not in use) the endpointer had
    // nothing to judge and fell back to the "unclear" wait on every turn. The
    // speculative decode usually lands well inside that window, so judge its
    // words instead: a complete sentence ends the hold early. Only ever
    // shortens — an unfinished one keeps the full wait, and if the user
    // resumes, onSpeechStart clears the timer and this does nothing.
    if (!heard && speculativePromiseRef.current) {
      const key = speculativeKeyRef.current;
      void speculativePromiseRef.current.then((text) => {
        if (!text || endpointTimerRef.current !== holdTimer || speculativeKeyRef.current !== key) return;
        const late = judgeEndpoint(text, prosodyContourRef.current);
        if (late.completeness !== "complete") return;
        clearTimer(endpointTimerRef);
        setHoldingForSpeech(false);
        debugLog(`endpoint: Whisper heard a complete turn — finalizing early (${late.reason})`);
        finishAndSendRef.current();
      });
    }
  }, []);
  considerEndpointRef.current = considerEndpoint;

  // ── Turn completion ───────────────────────────────────────────────────────
  /**
   * Resolve this turn's audio into a transcript and hand it to the app. Split
   * out from `finishAndSend` so that its many early returns all funnel through
   * one session-release point instead of repeating it.
   */
  const deliverTurn = useCallback(async (
    finalizeAt: number,
    stillCurrent: () => boolean,
  ): Promise<void> => {
    // VAD often ends the utterance before Web Speech promotes its latest interim
    // result to `isFinal`. Reusing that live text avoids an unnecessary Whisper
    // round trip and makes voice turns feel immediate.
    const webSpeechText = (liveTextRef.current || finalTextRef.current).replace(/\s+/g, " ").trim();
    let useWebSpeechResult =
      mode === "webspeech" ||
      (mode === "auto" && webSpeechWorkedRef.current && webSpeechText.length > 0);

    // Every segment this turn collected, joined back into one clip. A turn that
    // spanned a thinking pause has several; Whisper must see the whole thing or
    // it transcribes only the tail — the "half question" symptom, moved.
    const segments = segmentsRef.current;
    segmentsRef.current = [];
    const vadAudio = segments.length > 0 ? speechSegmentToWav(joinSegments(segments)) : null;

    // Web Speech sometimes catches one word of a long utterance and goes quiet
    // (a flaky connection to its hosted service), which used to submit "dial"
    // as the whole turn while several seconds of real speech sat in the VAD
    // buffer. Speech runs 2-3 words/second; text at well under 1 word/second
    // means the recognizer missed most of the utterance, so spend the Whisper
    // round trip on the full audio instead. Only in auto mode — an explicit
    // webspeech mode has no Whisper to fall back to.
    if (useWebSpeechResult && mode === "auto" && vadAudio) {
      const audioMs = segments.reduce((n, s) => n + s.length, 0) / 16; // 16kHz
      if (audioMs > 3000 && wordCount(webSpeechText) < audioMs / 2000) {
        debugLog(
          `STT: Web Speech text too thin for ${Math.round(audioMs)}ms of speech — using Whisper`,
        );
        useWebSpeechResult = false;
      }
    }
    vadAudioRef.current = null;
    const echoLatched = assistantEchoRef.current && !bargeInHandledRef.current;
    // Silence during playback only means "echo" if something was listening for
    // words. When the recognizer is down — Chrome's is a hosted service and
    // fails with `network` on a flaky connection — a real barge-in produces no
    // text either, and skipping Whisper would make interruption impossible in
    // exactly the degraded mode where it is hardest to be heard. Pay the round
    // trip in that case; it is the only ear left.
    const recognizerListening = !webSpeechDisabledRef.current && webSpeechFailuresRef.current === 0;
    // ...and it only means echo if nothing ELSE said otherwise. An acoustic
    // barge-in candidate is speech that outlasted MIN_INTERRUPTION_MS against
    // the guarded VAD threshold, which is deliberately set high enough to
    // reject most speaker bleed — we believed it enough to pause playback. To
    // then discard that same audio untranscribed is to answer our own question
    // with the one source that never saw the user: the hold can only ever
    // expire as a false interruption, so the assistant resumes its old topic
    // and a genuine change of subject is silently dropped. Whisper is the only
    // ear left when the recognizer returns nothing, so pay the round trip.
    const silentDuringPlayback =
      assistantAudible() &&
      !bargeInHandledRef.current &&
      !webSpeechText &&
      recognizerListening &&
      !acousticBargeInRaisedRef.current;

    let finalText = "";
    if (useWebSpeechResult) {
      finalText = cleanTranscript(webSpeechText);
      debugLog("STT path: Web Speech ->", finalText);
    } else if (echoLatched || silentDuringPlayback) {
      // Speaker echo. Sending it to Whisper costs a ~2s round trip and the
      // result is discarded anyway — a genuine barge-in reaches us either as
      // Web Speech text or as a confirmed interrupt, and neither lands here.
      debugLog("STT: skipped Whisper — audio is assistant echo");
    } else {
      // Whisper path: prefer VAD's trimmed WAV, else whatever the recorder has.
      let blob: Blob | null = vadAudio;
      if (!blob) {
        const recorderMime = recorderRef.current?.mimeType;
        await stopRecorder();
        const chunks = recordedRef.current;
        recordedRef.current = [];
        if (chunks.length > 0) blob = new Blob(chunks, { type: recorderMime || "audio/webm" });
      }
      if (!stillCurrent()) return;

      if (blob && blob.size >= MIN_WHISPER_BLOB_BYTES) {
        // Reuse the request started during the endpoint hold when it covers
        // exactly the audio being submitted — its decode has had the whole
        // hold window as a head start. Any mismatch (the user resumed, the
        // recorder path was used) falls through to a fresh request.
        const speculative =
          vadAudio && speculativeKeyRef.current === segmentsFingerprint(segments)
            ? speculativePromiseRef.current
            : null;
        speculativeKeyRef.current = "";
        speculativePromiseRef.current = null;
        try {
          let text = speculative ? await speculative : null;
          if (text !== null && speculative) debugLog("STT: speculative result reused");
          if (text === null) text = await transcribe(blob, whisperPromptRef.current ?? "", lang);
          if (!stillCurrent()) return;
          finalText = cleanTranscript(text);
          debugLog("STT path: Whisper ->", finalText);
        } catch (e) {
          if (!stillCurrent()) return;
          if (webSpeechText) {
            finalText = cleanTranscript(webSpeechText);
          } else {
            failWith((e as Error).message || "Transcription failed");
            return;
          }
        }
      } else if (webSpeechText) {
        finalText = cleanTranscript(webSpeechText);
      } else {
        debugLog("recording too small");
      }
    }

    if (!stillCurrent()) return;
    setInterim("");
    setState("idle");

    if (!finalText) return; // loop controller re-arms the mic on settle
    if (isLikelyHallucination(finalText)) {
      debugLog("Dropping likely hallucination:", JSON.stringify(finalText));
      return;
    }
    const prompt = whisperPromptRef.current;
    if (prompt && isPromptEcho(finalText, prompt)) {
      debugLog("Dropping Whisper prompt echo:", JSON.stringify(finalText));
      return;
    }
    if (echoLatched) {
      // The latch says our own voice is in here, not that nothing else is.
      // Chrome's recognizer emits no punctuation and does not stop when we
      // start speaking, so a barge-in arrives as one unbroken string: our
      // sentence, then the user's question. Dropping the whole utterance
      // silently deletes the question, and the user watches the assistant
      // answer something they never asked. Cut our words off the front and
      // keep what is left, if anything meaningful is.
      const salvaged = salvageEchoRef.current?.(finalText)?.trim() ?? "";
      if (!salvaged) {
        debugLog("assistant echo utterance discarded before submit:", finalText);
        return;
      }
      if (salvaged !== finalText.trim()) {
        debugLog("echo prefix cut from latched utterance:", finalText, "→", salvaged);
      }
      finalText = salvaged;
    }
    debugLog(
      `voice: capture→transcript ${Date.now() - finalizeAt}ms (${useWebSpeechResult ? "web speech" : "whisper"})`,
    );
    onTranscriptRef.current(finalText);
  }, [assistantAudible, failWith, lang, mode, stopRecorder]);

  const finishAndSend = useCallback(async () => {
    if (!listeningRef.current) return;
    const finalizeAt = Date.now();
    const turnGeneration = turnGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const stillCurrent = (): boolean =>
      turnGeneration === turnGenerationRef.current &&
      sessionGeneration === sessionGenerationRef.current;

    disarmTurn();
    setState("transcribing");

    try {
      await deliverTurn(finalizeAt, stillCurrent);
    } finally {
      // Push-to-talk owns the microphone for exactly one turn; a live call keeps
      // the session for the whole conversation. Releasing here rather than in
      // each early return guarantees the mic indicator can't stay lit.
      if (!continuousRef.current && sessionGeneration === sessionGenerationRef.current) {
        closeSession();
      }
    }
  }, [closeSession, deliverTurn, disarmTurn]);
  finishAndSendRef.current = () => { void finishAndSend(); };

  // ── Public API ────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (listeningRef.current) return;
    const opened = await openSession();
    if (!opened) return;
    // The session may have been closed while it was opening (mute, end call).
    if (!streamRef.current || listeningRef.current) return;
    armTurnRef.current();
  }, [openSession]);

  const stop = useCallback(() => {
    if (listeningRef.current) {
      void finishAndSend();
    } else {
      disarmTurn();
      setState("idle");
      setInterim("");
    }
  }, [disarmTurn, finishAndSend]);

  const cancel = useCallback(() => {
    turnGenerationRef.current++;
    closeSession();
    resetTurnState();
    // Muting, ending a call or switching language are deliberate acts; the next
    // attempt is a fresh start and shouldn't inherit a failure cooldown.
    sessionCooldownUntilRef.current = 0;
    setState("idle");
    setInterim("");
  }, [closeSession, resetTurnState]);

  const toggle = useCallback(async () => {
    if (state === "listening") {
      stop();
      return;
    }
    if (state === "idle" || state === "error") {
      sessionCooldownUntilRef.current = 0; // an explicit press always retries now
      await start();
    }
  }, [start, state, stop]);

  // Keep the acoustic guard in step with playback for the life of the turn, not
  // just at arm time — the assistant usually starts speaking mid-listen. This is
  // also where a context suspended mid-turn gets revived, since a suspended
  // context yields a microphone that looks open and hears nothing.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!listeningRef.current) return;
      applyVadGuard(assistantAudible());
      const ctx = vadCtxRef.current;
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {/* noop */});
    }, 250);
    return () => window.clearInterval(id);
  }, [applyVadGuard, assistantAudible]);

  // Release the microphone on unmount.
  useEffect(() => closeSession, [closeSession]);

  const supported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  const getLevel = useCallback(() => {
    const since = Date.now() - levelAtRef.current;
    if (since >= LEVEL_DECAY_MS) return 0;
    return levelRef.current * (1 - since / LEVEL_DECAY_MS);
  }, []);

  return { state, interim, start, cancel, stop, toggle, supported, getLevel, holdingForSpeech };
}
