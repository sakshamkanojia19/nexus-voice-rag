/* @refresh reset -- this stateful audio orchestrator must remount after hook edits in development. */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Menu, Plus, X } from "lucide-react";
import { NexusLogo } from "@/components/brand/NexusLogo";
import { AuthPage } from "@/components/auth/AuthPage";
import { useAccessGate } from "@/hooks/useAccessGate";
import { KEY_PROVIDERS, saveApiKey } from "@/lib/apiKey";
import { ownerKeyFor, purgeLegacyConversations } from "@/lib/chatStorage";
import { buildWhisperPrompt } from "@/lib/whisper-prompt";
import { useAuth } from "@/hooks/useAuth";
import { useChat } from "@/hooks/useChat";
import { useDocuments } from "@/hooks/useDocuments";
import { useSpeech } from "@/hooks/useSpeech";
import { prefetchVoiceAssets, useVoice } from "@/hooks/useVoice";
import { config, debugLog } from "@/lib/config";
import { loadLang, replyLanguageName, saveLang } from "@/lib/languages";
import { listModels, type SearchMode } from "@/lib/api";
import { loadSearchMode, saveSearchMode } from "@/lib/searchModes";
import type { VoiceAgent } from "@/lib/agents";
import { Sidebar } from "./Sidebar";
import { HeroSearch } from "./HeroSearch";
import { Conversation } from "./Conversation";
import { Composer } from "./Composer";
import { DocumentsPage } from "./DocumentsPage";
import { NProjectsPage } from "./NProjectsPage";
// Lazy: the strip pulls in framer-motion, and it's behind a click.
const VoiceAgentsStrip = lazy(() =>
  import("./VoiceAgentsStrip").then((m) => ({ default: m.VoiceAgentsStrip })),
);
// Same reason — the dedicated roster page shares those imports.
const VoiceAgentsPage = lazy(() =>
  import("./VoiceAgentsPage").then((m) => ({ default: m.VoiceAgentsPage })),
);
import { ECHO_TAIL_MS, isLikelyAssistantEcho, isLowInformationBargeIn, stripAssistantEcho, stripAssistantEchoPrefix } from "@/lib/echo";
import { playCallEnd, unlockCues } from "@/lib/audio-cues";
import { VoiceChatPage } from "./VoiceChatPage";
import type { VoiceVizState } from "./VoiceOrb";

type View = "chat" | "documents" | "nprojects" | "voicechat" | "voiceagents";

/**
 * The app's views as real URLs, so back/forward, refresh and deep links work
 * the way they do in every other chat app. The live voice call is deliberately
 * NOT a route: it holds an open microphone session, so it must be entered by
 * an explicit action, never by a pasted link or a browser-restored tab.
 */
const VIEW_PATHS = {
  chat: "/chat",
  documents: "/documents",
  nprojects: "/projects",
  voiceagents: "/voice-agents",
} as const;

type RoutedView = keyof typeof VIEW_PATHS;

function viewForPath(pathname: string): RoutedView | null {
  const found = (Object.keys(VIEW_PATHS) as RoutedView[]).find(
    (v) => VIEW_PATHS[v] === pathname,
  );
  return found ?? null;
}

/** How long a held reply waits for a confirming transcript before deciding the
 *  barge-in was a false positive and resuming. Mirrors LiveKit's
 *  `false_interruption_timeout`. Too short and real interruptions get talked
 *  over; too long and the assistant sits silent after a genuine one. */
const FALSE_INTERRUPTION_TIMEOUT_MS = 1200;

/** Recovery window for a hold raised on ACOUSTIC evidence alone (the Whisper
 *  path, where no interim text exists). It must outlast the endpoint hold plus
 *  the transcription round trip, or playback resumes right before the
 *  transcript arrives to confirm the interruption — the stutter-then-cut that
 *  makes barge-in feel broken. */
const ACOUSTIC_BARGE_IN_TIMEOUT_MS = 4000;

/**
 * What the assistant says the moment it starts a search during a live voice
 * call. A web search takes seconds, and to someone who can't see the screen
 * those seconds are indistinguishable from the app having missed the question —
 * which is what makes people repeat themselves. One short spoken line converts
 * that dead air into "working on it". Rotated so back-to-back searches don't
 * chant the same words.
 */
const SEARCH_ACKS_EN = ["Let me check that.", "One sec — looking that up.", "Let me find that for you."];
const SEARCH_ACKS_HI = ["एक पल, मैं देखती हूँ।", "रुकिए, अभी पता करती हूँ।"];

function searchAckPhrase(lang: string): string {
  const pool = lang.toLowerCase().startsWith("hi") ? SEARCH_ACKS_HI : SEARCH_ACKS_EN;
  return pool[Math.floor(Math.random() * pool.length)] ?? "Let me check that.";
}

/**
 * Said when the model is slow to start and no search was announced. A person
 * asked something says "hmm" within a second; four seconds of silence instead
 * reads as not having been heard. Shares the search ack's once-per-turn budget,
 * so a turn gets at most one of the two.
 */
const THINKING_FILLER_MS = 1400;
const THINKING_FILLERS_EN = ["Hmm, let me think.", "Okay, let me see.", "Let me think about that."];
const THINKING_FILLERS_HI = ["हम्म, सोचने दीजिए।", "एक सेकंड।"];

function thinkingFillerPhrase(lang: string): string {
  const pool = lang.toLowerCase().startsWith("hi") ? THINKING_FILLERS_HI : THINKING_FILLERS_EN;
  return pool[Math.floor(Math.random() * pool.length)] ?? "Hmm, let me think.";
}

export function RagApp() {
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>("chat");
  const location = useLocation();
  const navigate = useNavigate();

  // URL → view: deep links, refresh, and the back/forward buttons drive the
  // app. A live call is never overridden by history — leaving it is an
  // explicit action (end call), not a navigation.
  useEffect(() => {
    if (view === "voicechat") return;
    const routed = viewForPath(location.pathname);
    if (routed) {
      if (routed !== view) setView(routed);
    } else if (location.pathname !== VIEW_PATHS.chat) {
      // Unknown path (typo, stale link) normalizes to the chat.
      navigate(VIEW_PATHS.chat, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- URL is the input here
  }, [location.pathname]);

  // view → URL: every in-app navigation gets a real history entry.
  useEffect(() => {
    if (view === "voicechat") return;
    const path = VIEW_PATHS[view];
    if (location.pathname !== path) navigate(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view is the input here
  }, [view]);
  // Voice agents live in an inline drawer, so choosing a voice never takes you
  // out of the hero or the conversation you're in.
  const [voicesOpen, setVoicesOpen] = useState(false);
  // Latches on first open so the chunk loads once and exit animations still run.
  const [voicesMounted, setVoicesMounted] = useState(false);
  const openVoices = (next: boolean) => {
    if (next) setVoicesMounted(true);
    setVoicesOpen(next);
  };
  const [micMuted, setMicMuted] = useState(false);
  const [convLang, setConvLang] = useState<string>(loadLang);
  // Search mode persists across reloads — it's a working preference, not a
  // per-message choice, and re-picking it every visit would be tedious.
  const [searchMode, setSearchMode] = useState<SearchMode>(loadSearchMode);
  const [thinking, setThinking] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  // True while we're streaming a reply into the live-voice TTS queue.
  const streamingTtsRef = useRef(false);
  // Prevent a final network chunk from restarting TTS after the user barges in.
  const suppressTtsRef = useRef(false);
  // One spoken "let me check that" per turn, however many tools the agent runs.
  const searchAckSpokenRef = useRef(false);
  const assistantAudioGuardUntilRef = useRef(0);
  const assistantAudioWasActiveRef = useRef(false);

  const docs = useDocuments();

  // ── Identity changes wipe local state ──────────────────────────────────────
  // Everything below is per-account, and until this existed none of it was.
  // Conversations lived under a browser-scoped key, so signing out left the
  // previous person's chats on screen and signing in as somebody else adopted
  // them. The stored OpenAI key was worse: unscoped, so the next account to use
  // this browser would have spent the previous one's credit.
  //
  // Documents are refetched rather than cleared because the server owns them
  // and will simply return the new identity's set (or 401).
  const auth = useAuth((event) => {
    void docs.refresh();
    docs.resetSelection();

    // A key belongs to the account that entered it. Scoping it per user would
    // still leave a live credential in localStorage for anyone with devtools on
    // a shared machine, so sign-out deletes it outright — re-entry is a paste.
    if (event === "SIGNED_OUT") {
      saveApiKey(null);
      access.refreshApiKey();
    }

    // Anything the previous identity was mid-way through.
    clearFalseInterruptTimer();
    voice.cancel();
    speech.cancel();
    streamingTtsRef.current = false;
    suppressTtsRef.current = false;
    setInput("");
    setVoicesOpen(false);
    setSidebarOpen(false);
    setView("chat");
  });

  // Conversations are keyed by this, so it changing is what swaps history.
  const chatOwnerKey = ownerKeyFor(auth.user?.id);

  // The whole app loads for anyone. The gate only intervenes on the first action
  // that spends money or touches stored data, collects what the deployment
  // requires — an account, then a key — and then runs the action the user
  // originally asked for. `onSatisfied` is that replay; the handlers it calls
  // are defined further down and are always initialised by the time an effect
  // inside the hook can fire.
  const access = useAccessGate({
    auth,
    onSatisfied: (intent) => {
      if (intent.kind === "chat") sendNow(intent.text);
      else if (intent.kind === "voice") enterVoiceChat();
      else if (intent.kind === "upload") void docs.addFiles(intent.files);
    },
    // Signed in, but a key is still needed. Rather than stack a second demand
    // on the first, we drop the user back into the app — signed in, their email
    // in the sidebar — and give them their question back. Pressing send again
    // is what raises the key step.
    onDeferred: (intent) => {
      if (intent?.kind === "chat") setInput(intent.text);
    },
  });

  // Dismissing the gate abandons the action, so a question that was taken out of
  // the composer to be sent has to go back into it. Losing what someone typed
  // because they decided not to sign in yet is the rudest possible outcome.
  const closeGate = () => {
    if (access.pending?.kind === "chat") setInput(access.pending.text);
    access.close();
  };
  const speech = useSpeech({ lang: convLang });
  const replyLanguage = replyLanguageName(convLang);

  // The thinking filler: armed when a voice turn is sent, disarmed by the
  // first token, the final answer, a new turn, or leaving the call.
  const thinkingFillerTimerRef = useRef<number | null>(null);
  const clearThinkingFiller = () => {
    if (thinkingFillerTimerRef.current !== null) {
      window.clearTimeout(thinkingFillerTimerRef.current);
      thinkingFillerTimerRef.current = null;
    }
  };
  const startThinkingFiller = () => {
    clearThinkingFiller();
    if (view !== "voicechat" || !speech.enabled) return;
    thinkingFillerTimerRef.current = window.setTimeout(() => {
      thinkingFillerTimerRef.current = null;
      if (suppressTtsRef.current || streamingTtsRef.current || searchAckSpokenRef.current) return;
      searchAckSpokenRef.current = true;
      speech.speak(thinkingFillerPhrase(convLang));
    }, THINKING_FILLER_MS);
  };
  useEffect(() => clearThinkingFiller, []);
  const chat = useChat({
    // Conversations are stored per account. Changing this swaps the history and
    // clears the view, which is what makes sign-out come back to a fresh app.
    ownerKey: chatOwnerKey,
    // Speak incrementally during a live voice call (low latency, like ChatGPT
    // voice): each newly-complete sentence is queued as it streams in.
    onAssistantDelta: (full) => {
      clearThinkingFiller();
      if (view !== "voicechat" || !speech.enabled || suppressTtsRef.current) return;
      if (!streamingTtsRef.current) {
        speech.streamReset();
        streamingTtsRef.current = true;
      }
      speech.streamPush(full);
    },
    // Spoken progress: the agent just announced a search, which is the start of
    // the longest silent stretch in a voice turn. Speak a one-liner so the user
    // knows they were heard. Never during answer playback (streamingTtsRef), and
    // once per turn — a two-tool round shouldn't produce a two-line monologue.
    onToolActivity: (_name, _query, fromVoice) => {
      if (!fromVoice || view !== "voicechat" || !speech.enabled) return;
      if (suppressTtsRef.current || streamingTtsRef.current || searchAckSpokenRef.current) return;
      searchAckSpokenRef.current = true;
      speech.speak(searchAckPhrase(convLang));
    },
    onAssistantFinal: (text, fromVoice) => {
      clearThinkingFiller();
      if (view === "voicechat") {
        if (suppressTtsRef.current) {
          streamingTtsRef.current = false;
          return;
        }
        if (streamingTtsRef.current) {
          speech.streamEnd(text);
          streamingTtsRef.current = false;
        } else if (speech.enabled && text.trim()) {
          speech.speak(text); // fallback if no deltas were streamed
        }
        return;
      }
      if (fromVoice && text.trim()) speech.speak(text);
    },
    // A refusal the client failed to predict — an expired session, or flags
    // changed under us. Open the dialog that fixes it rather than leaving
    // "401 Sign in to continue" sitting in the transcript.
    onAccessError: (err) => access.handleAccessError(err.reason),
  });

  const botName = config.botName;

  // ── Two-phase barge-in (LiveKit's false-interruption recovery, locally) ──────
  // Phase 1 `holdAssistant`: a candidate interruption only PAUSES playback. The
  // LLM stream is deliberately left running — aborting it is irreversible, so it
  // must wait for confirmation.
  // Phase 2 is either `commitInterrupt` (a real transcript arrived → cancel,
  // abort, truncate history to what was heard) or `recoverFalseInterruption`
  // (the timer expired with nothing valid → resume exactly where we stopped).
  const falseInterruptTimerRef = useRef<number | null>(null);
  /** Whether the voice pipeline still owes us a verdict on the current
   *  utterance. Read from a timer callback, so it has to be a ref — a captured
   *  `voice.state` would be whatever it was when the hold was armed. */
  const voiceBusyRef = useRef(false);

  const clearFalseInterruptTimer = (): void => {
    if (falseInterruptTimerRef.current !== null) {
      window.clearTimeout(falseInterruptTimerRef.current);
      falseInterruptTimerRef.current = null;
    }
  };

  const recoverFalseInterruption = (): void => {
    clearFalseInterruptTimer();
    if (!speech.held()) return;
    // The timer answers "nothing came of that noise" — but only silence proves
    // that. While the user is still talking, or a transcript is still being
    // decoded, the answer is simply not in yet, and resuming produces the worst
    // outcome available: playback restarts, the transcript lands a moment
    // later, and commitInterrupt cuts it off again. The user hears the reply
    // stutter back to life and die, which reads as the assistant malfunctioning
    // rather than as being interrupted. So wait, and re-arm.
    if (voiceBusyRef.current) {
      falseInterruptTimerRef.current = window.setTimeout(
        recoverFalseInterruption,
        FALSE_INTERRUPTION_TIMEOUT_MS,
      );
      debugLog("voice: hold extended — still listening/transcribing");
      return;
    }
    speech.release();
    debugLog("voice: false interruption — resumed playback");
  };

  const holdAssistant = (timeoutMs: number = FALSE_INTERRUPTION_TIMEOUT_MS): boolean => {
    const wasBusy = chat.isStreaming || speech.speaking || streamingTtsRef.current;
    if (!wasBusy) return false;
    if (!speech.held()) {
      speech.hold();
      debugLog("voice: suspected barge-in — playback held pending confirmation");
    }
    clearFalseInterruptTimer();
    falseInterruptTimerRef.current = window.setTimeout(recoverFalseInterruption, timeoutMs);
    return true;
  };

  const commitInterrupt = (): boolean => {
    clearThinkingFiller();
    clearFalseInterruptTimer();
    const wasBusy = chat.isStreaming || speech.speaking || streamingTtsRef.current;
    if (!wasBusy) return false;
    // Capture what actually reached the speaker BEFORE cancel() clears it.
    const heard = speech.getSpokenText();
    suppressTtsRef.current = true;
    streamingTtsRef.current = false;
    speech.cancel();
    chat.abort();
    chat.truncateLastAssistant(heard);
    debugLog("voice barge-in committed; history truncated to heard text:", heard);
    return true;
  };

  const latestAssistantText = (): string =>
    [...chat.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";

  /** Whether the reply currently streaming has produced any text yet. Distinguishes
   *  "reading the question" from "composing the answer". */
  const lastAssistantHasText =
    ([...chat.messages].reverse().find((m) => m.role === "assistant")?.content ?? "").trim().length > 0;

  const assistantMayBeAudible = (): boolean =>
    chat.isStreaming || speech.speaking || streamingTtsRef.current || Date.now() < assistantAudioGuardUntilRef.current;

  // `activeDocNames` is a fresh array each render, so it is unusable as a memo
  // dependency directly. The key is JSON rather than a delimiter join because
  // document titles contain spaces, commas and most other separators worth
  // picking.
  const activeDocNames = docs.activeDocNames;
  const activeDocNamesKey = JSON.stringify(activeDocNames);
  const whisperPrompt = useMemo(
    () => buildWhisperPrompt(activeDocNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value, not identity
    [activeDocNamesKey],
  );

  const voice = useVoice({
    lang: convLang,
    // Tell Whisper what this user is likely to be talking about. Without it the
    // decoder falls back to general-English priors, where "drag" beats "RAG"
    // and a grounded document's title has no chance at all.
    whisperPrompt,
    // Lets the capture pipeline tighten its acoustic gate and skip the Whisper
    // round trip while our own audio is what the mic is most likely hearing.
    isAssistantAudible: assistantMayBeAudible,
    // A live call holds one microphone session for the whole conversation;
    // composer push-to-talk releases the mic after its single turn.
    continuous: view === "voicechat",
    onSpeechCandidate: (text) => {
      if (assistantMayBeAudible() && isLowInformationBargeIn(text)) {
        debugLog("voice: lone-word candidate ignored during playback:", text);
        recoverFalseInterruption();
        return "echo";
      }
      if (assistantMayBeAudible() && isLikelyAssistantEcho(text, latestAssistantText())) {
        debugLog("voice echo ignored during assistant playback:", text);
        // A candidate we rejected as echo must not leave playback held.
        recoverFalseInterruption();
        return "echo";
      }
      // Only a tentative hold here — the utterance is still in progress and may
      // yet be filtered out as echo or a hallucination.
      return holdAssistant() ? "interrupt" : "accept";
    },
    // Sustained speech over our playback with no words to judge yet — the
    // Whisper path's only early interruption signal. Pause now, with a window
    // long enough for the transcript to arrive and either commit (real speech)
    // or be discarded as echo (the timer then resumes playback).
    // Only reached when the echo latch was about to bin the whole utterance.
    // Returns "" for pure echo (the latch was right) and the user's half when
    // our reply merely got glued to the front of it.
    salvageEcho: (text) => {
      const assistant = latestAssistantText();
      if (!assistant) return text;
      const cut = stripAssistantEchoPrefix(text, assistant);
      if (cut === text) return "";
      if (isLowInformationBargeIn(cut) || isLikelyAssistantEcho(cut, assistant)) return "";
      return cut;
    },
    onAcousticBargeIn: () => {
      if (holdAssistant(ACOUSTIC_BARGE_IN_TIMEOUT_MS)) {
        debugLog("voice: acoustic barge-in — playback held for transcript");
      }
    },
    onTranscript: (text) => {
      // A barge-in records BOTH voices: the mic hears the tail of our own reply
      // through the speakers, then the user. Whisper transcribes the mix, and
      // without this cut the assistant's sentences would be submitted as the
      // user's words — poisoning the history and derailing the conversation.
      if (assistantMayBeAudible()) {
        const cleaned = stripAssistantEcho(text, latestAssistantText());
        if (cleaned !== text) {
          debugLog("echo sentences cut from mixed transcript:", text, "→", cleaned);
          text = cleaned;
        }
        if (!text.trim()) {
          debugLog("assistant echo transcript discarded (every sentence matched)");
          recoverFalseInterruption();
          return;
        }
      }
      // Whisper returns garbled single fragments when it decodes speaker echo
      // ("hej", "edge", "čveč"). They resemble nothing the assistant said, so
      // the echo matcher can't catch them — drop them on shape instead.
      if (assistantMayBeAudible() && isLowInformationBargeIn(text)) {
        debugLog("assistant echo fragment discarded (lone word):", text);
        recoverFalseInterruption();
        return;
      }
      if (assistantMayBeAudible() && isLikelyAssistantEcho(text, latestAssistantText())) {
        debugLog("assistant echo transcript discarded:", text);
        recoverFalseInterruption();
        return;
      }
      // A validated transcript is the confirmation the hold was waiting for.
      // Also covers Whisper-only/fallback recognition, where no interim
      // candidate ever reached onSpeechCandidate.
      if (chat.isStreaming || speech.speaking || streamingTtsRef.current) {
        commitInterrupt();
      } else {
        clearFalseInterruptTimer();
      }
      // A confirmed non-echo candidate aborts the previous response before
      // this completed utterance becomes the next turn.
      suppressTtsRef.current = false;
      searchAckSpokenRef.current = false;
      startThinkingFiller();
      setInput("");
      void chat.send(text, {
        fromVoice: true,
        docIds: docs.readyCount > 0 ? docs.activeDocIds : null,
        botName,
        replyLanguage,
      });
    },
    onError: (msg) => console.warn("[Nexus] voice:", msg),
  });

  // VAD closes an utterance after trailing silence, so speaker echo can arrive
  // well after speechSynthesis reports completion — and on the Whisper path a
  // network round-trip lands on top of that. The old 900ms tail expired first,
  // which let the tail of every reply through the echo check unexamined and
  // start a self-conversation. Keep only echo-matching words guarded; a
  // different user utterance can still pass immediately.
  useEffect(() => {
    if (speech.speaking) {
      assistantAudioWasActiveRef.current = true;
      assistantAudioGuardUntilRef.current = Number.POSITIVE_INFINITY;
    } else if (assistantAudioWasActiveRef.current) {
      assistantAudioWasActiveRef.current = false;
      assistantAudioGuardUntilRef.current = Date.now() + ECHO_TAIL_MS;
    }
  }, [speech.speaking]);

  // Warm the VAD/ONNX bundles while the user is reading the hero, so the first
  // mic press starts listening immediately instead of waiting on a CDN fetch.
  useEffect(prefetchVoiceAssets, []);

  // Conversations written before they were scoped to an account belong to
  // nobody and may be a previous user's. Drop them once, on first load.
  useEffect(() => {
    const dropped = purgeLegacyConversations(window.localStorage);
    if (dropped) debugLog(`purged ${dropped} unscoped conversation bucket(s)`);
  }, []);

  // The picker's options come from the server's allowlist for whichever
  // provider the saved key belongs to, so they are refetched when that changes.
  // A pick from the previous provider's list would only be ignored server-side,
  // so it is dropped back to Auto. A failure here just leaves the list empty,
  // which hides the picker and falls back to Auto.
  const keyProvider = access.keyProvider;
  useEffect(() => {
    let cancelled = false;
    void listModels()
      .then((r) => {
        if (cancelled) return;
        const next = r.models ?? [];
        setModels(next);
        setModel((current) => (current && next.includes(current) ? current : null));
      })
      .catch((e) => debugLog("model list unavailable", e));
    return () => { cancelled = true; };
  }, [keyProvider]);

  const changeSearchMode = (next: SearchMode) => {
    setSearchMode(next);
    saveSearchMode(next);
    // Instant runs one toolless pass on a small model, so neither reasoning
    // effort nor a model override applies. Clear them rather than carry a
    // setting the request will drop anyway.
    if (next === "instant") {
      setThinking(false);
      setModel(null);
    }
  };

  // A held reply must never outlive the component, or playback stays frozen.
  useEffect(() => clearFalseInterruptTimer, []);

  const changeLang = (code: string) => {
    // Recognition.lang is fixed when a SpeechRecognition session starts.
    // Cancel the old capture first; the voice-chat re-arm effect starts a fresh
    // session with the new BCP-47 language on the next render.
    clearFalseInterruptTimer();
    voice.cancel();
    chat.abort();
    setConvLang(code);
    saveLang(code);
    speech.cancel(); // drop any in-flight speech in the old language
    streamingTtsRef.current = false;
    suppressTtsRef.current = false;
  };

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSidebarOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const hasMessages = chat.messages.length > 0;
  // The newest turn failing is what the call screen needs to show; the next
  // question replaces it, which clears the message on its own.
  const lastTurn = chat.messages[chat.messages.length - 1];
  const voiceError = lastTurn?.status === "error" ? lastTurn.content : null;

  // The send itself, with no gate in front of it. Split out so the access gate
  // can replay exactly this — same text, same grounding, same mode — once the
  // account and key are in place.
  const sendNow = (text: string) => {
    setView("chat");
    void chat.send(text, {
      fromVoice: false,
      docIds: docs.readyCount > 0 ? docs.activeDocIds : null,
      botName,
      replyLanguage,
      mode: searchMode,
      thinking,
      model,
    });
  };

  // `override` carries a picked suggestion: the composer's onChange hasn't been
  // applied to `input` yet on the tick the pick fires, so reading state here
  // would send the previous keystroke's text.
  const handleSend = (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || chat.isStreaming) return;
    // Clear either way: the question is now in flight, or parked in the gate
    // which will either replay it or hand it back to the composer on dismissal.
    setInput("");
    if (!access.gate({ kind: "chat", text })) return;
    sendNow(text);
  };

  // Uploading embeds every chunk, and only OpenAI offers embeddings — the
  // server refuses uploads on a Grok or Groq key (400). Say so up front and at
  // the moment of trying, rather than letting the upload fail out of sight.
  // The key in use is the caller's own if they saved one, else the server's.
  const uploadProvider = access.keyProvider ?? access.caps?.provider ?? null;
  const uploadBlocked =
    uploadProvider && uploadProvider !== "openai"
      ? `Uploading documents needs an OpenAI key — ${
          KEY_PROVIDERS.find((p) => p.id === uploadProvider)?.label ?? "this provider"
        } can't create the embeddings document search runs on. Chat, web search and voice work with your current key.`
      : null;

  // The document-error toast closes itself after a few seconds, but not while
  // the pointer is on it — it carries a button, and reaching for it shouldn't
  // be a race against the timer.
  const DOC_TOAST_MS = 3000;
  const docToastTimerRef = useRef<number | null>(null);
  const docToastHoveredRef = useRef(false);
  const docToastVisible = !!docs.error && view !== "documents" && access.step === null;
  const armDocToast = () => {
    if (docToastTimerRef.current !== null) window.clearTimeout(docToastTimerRef.current);
    docToastTimerRef.current = window.setTimeout(() => {
      docToastTimerRef.current = null;
      if (!docToastHoveredRef.current) docs.clearError();
    }, DOC_TOAST_MS);
  };
  useEffect(() => {
    if (!docToastVisible) return;
    armDocToast();
    return () => {
      if (docToastTimerRef.current !== null) window.clearTimeout(docToastTimerRef.current);
      docToastTimerRef.current = null;
    };
    // Re-armed per message: a second refusal gets its own full three seconds.
  }, [docToastVisible, docs.error]);

  const attachFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    if (!list.length) return;
    if (uploadBlocked) {
      docs.reportError(uploadBlocked);
      return;
    }
    if (!access.gate({ kind: "upload", files: list })) return;
    await docs.addFiles(list);
  };

  // Every upload entry point — the composer's paperclip, the documents page's
  // drop zone and its file picker — goes through the gate. Substituting the one
  // method is what makes that true everywhere rather than at the call sites we
  // happened to remember.
  const gatedDocs = { ...docs, addFiles: attachFiles };

  const newChat = () => {
    clearFalseInterruptTimer();
    voice.cancel();
    speech.cancel();
    chat.abort();
    streamingTtsRef.current = false;
    suppressTtsRef.current = false;
    chat.clear();
    docs.resetSelection(); // a fresh chat starts with no document grounded
    setInput("");
    setView("chat");
    setSidebarOpen(false);
  };

  // ── Live voice-chat (continuous, hands-free conversation loop) ─────────────
  // A single derived state machine drives the whole loop + the visualizer:
  //   listening → (transcript) → thinking → speaking → idle → re-arm mic …
  // "Understanding" is the gap between the user finishing and the first token
  // arriving: transcription, then the model reading the question. Previously
  // that window showed "Listening…" or nothing, so a slow first token looked
  // like the app had missed the question entirely — which is what makes people
  // repeat themselves and talk over the answer.
  const understanding =
    voice.state === "transcribing" || (chat.isStreaming && !lastAssistantHasText);

  // Kept current every render so the false-interruption timer reads live state.
  voiceBusyRef.current =
    voice.state === "listening" || voice.state === "transcribing" || voice.holdingForSpeech;

  const convState: VoiceVizState =
    speech.speaking
      ? "speaking" // audio may start while the reply is still streaming
      : voice.state === "listening"
        ? "listening"
        : understanding
          ? "understanding"
          : chat.isStreaming
            ? "thinking"
            : "idle";

  // Keep the mic armed throughout a live call so speech can interrupt an answer.
  // Browser echo cancellation plus VAD reduce accidental speaker-output pickup.
  // Re-arming no longer reopens the microphone — useVoice holds one capture
  // session for the whole call — so this is just a debounce against re-arming
  // twice in the same burst of renders, not a wait for hardware.
  useEffect(() => {
    if (view !== "voicechat" || micMuted) return;
    if (voice.state !== "idle") return; // listening or transcribing
    const t = window.setTimeout(() => {
      void voice.start();
    }, 60);
    return () => window.clearTimeout(t);
    // voice.start is stable; intentionally not in deps to avoid re-arm churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, micMuted, voice.state, chat.isStreaming, speech.speaking]);

  // Leaving the call releases the microphone even when we didn't exit through
  // the End button — picking a conversation, opening Documents, and so on. The
  // capture session now outlives a turn, so nothing else would close it.
  useEffect(() => {
    if (view === "voicechat") return;
    voice.cancel();
    // voice.cancel is stable; listing it would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ...and releases the SPEECH side too, but only on the actual transition out
  // of a call. Dropping the mic while leaving a held reply paused was a way to
  // wedge the whole call: a barge-in hold pauses speechSynthesis globally and
  // arms a recovery timer, and navigating away (the /voice-agents picker is a
  // route, not an overlay) skipped both the release and the timer's owner. The
  // synth stayed paused, the pending timer resumed a reply into a view that no
  // longer existed, and because the mic had been released the call was over
  // without ever saying so. Guarded on the previous view rather than on
  // `view !== "voicechat"`, which would also fire on ordinary chat→documents
  // navigation and cut off text-mode TTS that has nothing to do with a call.
  const prevViewRef = useRef(view);
  useEffect(() => {
    const leftCall = prevViewRef.current === "voicechat" && view !== "voicechat";
    prevViewRef.current = view;
    if (!leftCall) return;
    clearFalseInterruptTimer();
    speech.cancel();
    streamingTtsRef.current = false;
    suppressTtsRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const enterVoiceChat = () => {
    speech.unlock();
    // Same gesture that unlocks TTS warms the cue context, so the hang-up blip
    // isn't the call that first trips the autoplay policy.
    unlockCues();
    if (!speech.enabled) speech.setEnabled(true);
    suppressTtsRef.current = false;
    streamingTtsRef.current = false;
    setMicMuted(false);
    setSidebarOpen(false);
    setView("voicechat");
  };

  const startVoiceChat = () => {
    // Gated before `speech.unlock()`: no point warming an audio pipeline for a
    // call a dialog is about to block.
    //
    // The replay runs from an effect a tick after the dialog's save click, not
    // from the click itself, so it leans on the browser's transient user
    // activation still being live. That holds for the in-tab paths (password,
    // saving a key). It cannot hold across a Google redirect — but that reloads
    // the page, which drops the parked intent anyway, so there is nothing to
    // replay and the user simply clicks voice again.
    if (!access.gate({ kind: "voice" })) return;
    enterVoiceChat();
  };

  const endVoiceChat = () => {
    clearThinkingFiller();
    clearFalseInterruptTimer();
    voice.cancel();
    speech.cancel();
    chat.abort();
    // After speech.cancel(), so the blip lands in silence rather than on top of
    // the assistant's last syllable.
    playCallEnd();
    streamingTtsRef.current = false;
    suppressTtsRef.current = true;
    setMicMuted(false);
    setView("chat");
  };

  const toggleConvMic = () => {
    if (micMuted) {
      setMicMuted(false); // effect re-arms the mic
    } else {
      setMicMuted(true);
      voice.cancel();
    }
  };

  const toggleConvTts = () => {
    speech.unlock();
    if (speech.enabled) {
      speech.cancel();
      streamingTtsRef.current = false;
    }
    speech.setEnabled(!speech.enabled);
  };

  // ── Read-aloud (the speaker button under an assistant message) ─────────────
  // Which message that button is currently playing. Held here rather than in
  // the message, because only one can play at a time — starting a second must
  // visibly stop the first.
  const [readingId, setReadingId] = useState<string | null>(null);

  // Playback can end without the button being touched: the utterance finishes,
  // a voice call cancels it, the language changes. Track the synthesizer rather
  // than assuming, or the button would keep offering "Stop" for silence.
  useEffect(() => {
    if (!speech.speaking) setReadingId(null);
  }, [speech.speaking]);

  const toggleReadAloud = (turn: { id: string; content: string }) => {
    speech.unlock();
    if (readingId === turn.id) {
      speech.cancel();
      setReadingId(null);
      return;
    }
    // A different message: speak() cancels whatever is playing, so switching is
    // just bookkeeping. Empty content would leave the button stuck on "Stop"
    // because speak() no-ops and `speaking` never goes true.
    const text = turn.content.trim();
    if (!text) return;
    // `force`: the "voice replies" switch controls whether answers are read
    // automatically. Pressing this button is an explicit request, so it plays
    // even when that switch is off — otherwise the button silently does nothing
    // and looks broken.
    speech.speak(text, { force: true });
    setReadingId(turn.id);
  };

  const selectAgent = (a: VoiceAgent) => {
    speech.unlock();
    speech.selectVoice(a.voiceName); // persist the exact browser voice
    if (!speech.enabled) speech.setEnabled(true); // so it actually reads replies aloud
    speech.previewVoice(a.voiceName, `Hi, I'm Nexus, speaking as ${a.name}. This is how I'll sound.`);
  };

  const voiceStripProps = {
    open: voicesOpen,
    voices: speech.voices,
    selectedVoice: speech.selectedVoice,
    speakingVoice: speech.speaking ? speech.voiceName : null,
    onSelect: selectAgent,
    onClose: () => openVoices(false),
    onShowAll: () => {
      openVoices(false);
      setView("voiceagents");
    },
  };

  const voiceStrip = (className?: string) =>
    voicesMounted ? (
      <Suspense fallback={null}>
        <VoiceAgentsStrip {...voiceStripProps} className={className} />
      </Suspense>
    ) : null;

  const composerProps = {
    value: voice.interim || input,
    onChange: setInput,
    onSend: handleSend,
    onStop: chat.abort,
    isStreaming: chat.isStreaming,
    onMicToggle: () => {
      speech.unlock();
      speech.cancel();
      void voice.toggle();
    },
    // Discard: drop the capture without transcribing or sending it, and clear
    // whatever interim text had already landed in the field. Without this the
    // only exit from a mis-tapped mic is to let it finish and then delete the
    // result by hand.
    onVoiceCancel: () => {
      voice.cancel();
      setInput("");
    },
    voiceState: voice.state,
    voiceSupported: voice.supported,
    ttsEnabled: speech.enabled,
    ttsVoiceName: speech.voiceName,
    onTtsToggle: () => {
      speech.unlock();
      if (speech.enabled) speech.cancel();
      speech.setEnabled(!speech.enabled);
    },
    onTtsTest: () => {
      speech.unlock();
      speech.test();
    },
    voices: speech.voices,
    selectedVoice: speech.selectedVoice,
    onSelectVoice: speech.selectVoice,
    onAttachFiles: attachFiles,
    documents: docs.documents,
    onRemoveDoc: docs.remove,
    isDocSelected: docs.isSelected,
    onToggleDoc: docs.toggleSelected,
    onStartVoiceChat: voice.supported ? startVoiceChat : undefined,
    lang: convLang,
    onLangChange: changeLang,
    mode: searchMode,
    onModeChange: changeSearchMode,
    thinking,
    onThinkingChange: setThinking,
    models,
    model,
    onModelChange: setModel,
  };

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* Static, flat grey background (no animation) with a soft CiteTalk-style
          spotlight near the top-centre. */}
      <div className="chat-static-bg" />

      <Sidebar
        onNewChat={newChat}
        onShowDocuments={() => { setView("documents"); setSidebarOpen(false); }}
        onShowNProjects={() => { setView("nprojects"); setSidebarOpen(false); }}
        onShowVoices={() => { setView("voiceagents"); setSidebarOpen(false); }}
        activePanel={view === "documents" || view === "nprojects" || view === "voiceagents" ? view : null}
        conversations={chat.conversations}
        activeId={chat.activeId}
        onSelectConversation={(id) => { chat.selectConversation(id); setView("chat"); setSidebarOpen(false); }}
        onRenameConversation={chat.renameConversation}
        onDeleteConversation={chat.deleteConversation}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        auth={auth}
        onSignIn={() => { access.openSignIn(); setSidebarOpen(false); }}
        // Hidden when the deployment doesn't take user keys, and hidden again
        // until there is an account to attach one to. A signed-out visitor has
        // no use for the row: the server would refuse the key, and naming a
        // credential before anyone has asked to sign in is the exact prompt
        // this whole flow exists to avoid.
        onManageApiKey={
          access.caps?.byok?.accepted &&
          !(access.requirements.keyNeedsAuth && auth.user === null)
            ? () => { access.openApiKey(); setSidebarOpen(false); }
            : undefined
        }
        hasApiKey={access.hasApiKey}
      />

      <main className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/* Top bar (hidden during the full-screen voice call) */}
        {view !== "voicechat" ? (
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted md:hidden"
          >
            <Menu className="size-5" />
          </button>
          <div className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
            {hasMessages && view === "chat" ? (
              <>
                <NexusLogo className="size-5 shrink-0 rounded-md" />
                {botName}
              </>
            ) : null}
          </div>
          {hasMessages ? (
            <button
              onClick={newChat}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Plus className="size-3.5" /> New
            </button>
          ) : (
            <div className="size-9 md:hidden" />
          )}
        </header>
        ) : null}

        {view === "voicechat" ? (
          <div className="min-h-0 flex-1">
            <VoiceChatPage
              state={convState}
              getLevel={voice.getLevel}
              getSpeechPulse={speech.getSpeechPulse}
              botName={botName}
              holdingForSpeech={voice.holdingForSpeech}
              micMuted={micMuted}
              onToggleMic={toggleConvMic}
              ttsEnabled={speech.enabled}
              onToggleTts={toggleConvTts}
              onInterrupt={commitInterrupt}
              onEnd={endVoiceChat}
              voices={speech.voices}
              selectedVoice={speech.selectedVoice}
              activeVoiceName={speech.voiceName}
              onSelectVoice={speech.selectVoice}
              lang={convLang}
              onLangChange={changeLang}
              error={voiceError}
            />
          </div>
        ) : view === "documents" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DocumentsPage
              docs={gatedDocs}
              onClose={() => setView("chat")}
              uploadBlocked={uploadBlocked}
              onManageKey={access.openApiKey}
            />
          </div>
        ) : view === "nprojects" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NProjectsPage onClose={() => setView("chat")} />
          </div>
        ) : view === "voiceagents" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={null}>
              <VoiceAgentsPage
                voices={speech.voices}
                selectedVoice={speech.selectedVoice}
                speakingVoice={speech.speaking ? speech.voiceName : null}
                onSelect={selectAgent}
                onUseAuto={() => {
                  speech.unlock();
                  speech.selectVoice(null);
                }}
                onClose={() => setView("chat")}
              />
            </Suspense>
          </div>
        ) : hasMessages ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Conversation
                messages={chat.messages}
                voiceState={voice.state}
                voiceInterim={voice.interim}
                onSpeak={toggleReadAloud}
                speakingId={readingId}
              />
            </div>
            <div className="shrink-0 px-4 pb-5 pt-2 animate-fade-in">
              <div className="mx-auto w-full max-w-3xl">
                {voiceStrip("mb-1")}
                <Composer {...composerProps} variant="docked" />
                <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
                  {botName} can make mistakes — check cited sources.
                </p>
              </div>
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <HeroSearch
              composerProps={composerProps}
              onShowDocuments={() => setView("documents")}
              onShowVoices={() => openVoices(!voicesOpen)}
              voicesOpen={voicesOpen}
              greetingName={auth.user?.name?.split(" ")[0] ?? null}
            />
            {/* Roster expands beneath the hero, wider than the search column */}
            <div className="mx-auto w-full max-w-5xl shrink-0 px-6 pb-10">{voiceStrip()}</div>
          </div>
        )}
      </main>

      {/* Document errors raised away from the Documents page — the composer's
          attach button, a drop onto the chat — which otherwise had nowhere to
          show and made an upload look like it silently did nothing. */}
      <AnimatePresence>
        {docToastVisible ? (
          <motion.div
            key="doc-error"
            role="alert"
            onMouseEnter={() => { docToastHoveredRef.current = true; }}
            onMouseLeave={() => { docToastHoveredRef.current = false; armDocToast(); }}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="fixed right-4 top-4 z-[90] flex w-[min(400px,calc(100vw-2rem))] items-start gap-2.5 rounded-xl border border-destructive/30 bg-popover px-3.5 py-3 text-[13px] leading-relaxed text-foreground shadow-soft"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span className="min-w-0 flex-1">
              {docs.error}
              {uploadBlocked && docs.error === uploadBlocked ? (
                <button
                  type="button"
                  onClick={() => { docs.clearError(); access.openApiKey(); }}
                  className="ml-1.5 font-medium text-primary hover:underline"
                >
                  Add an OpenAI key
                </button>
              ) : null}
            </span>
            <button type="button" onClick={docs.clearError} aria-label="Dismiss" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* A dedicated page, not an overlay dialog: the app stays mounted behind
          it so returning is instant and nothing is lost, but while it is up the
          user is in one place doing one thing. */}
      <AnimatePresence>
        {access.step !== null ? (
          <AuthPage
            key="auth-page"
            step={access.step}
            auth={auth}
            requirements={access.requirements}
            intent={access.pending}
            misconfigured={access.misconfigured}
            onBack={closeGate}
            onKeySaved={access.refreshApiKey}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
