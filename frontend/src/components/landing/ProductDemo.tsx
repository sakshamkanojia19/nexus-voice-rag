import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  BriefcaseBusiness,
  FileText,
  FolderOpen,
  Globe,
  Mic,
  PhoneOff,
  Plus,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { NexusLogo } from "@/components/brand/NexusLogo";
import { MessageItem } from "@/components/rag/MessageItem";
import { VoiceOrb, type VoiceVizState } from "@/components/rag/VoiceOrb";
import { AgentAvatar } from "@/components/rag/AgentAvatar";
import { greetingFor, topAgents, voicesToAgents, type VoiceAgent } from "@/lib/agents";
import type { VoiceOption } from "@/hooks/useSpeech";
import type { ChatTurn } from "@/hooks/useChat";
import type { Source } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The landing page's product showcase: a scaled replica of the real app shell
 * (sidebar, composer, chat column) that plays short scripted sessions.
 *
 * Built from the app's own components — `MessageItem` (with its live search
 * timeline, citation chips and source cards), `VoiceOrb` and `AgentAvatar` —
 * rather than drawn mockups, so what a visitor sees here is exactly what they
 * get after signing in. Every fact in the scripted answers is true and every
 * source link resolves.
 */

export type DemoId = "voice" | "web" | "docs" | "deep" | "agents";

export const DEMOS: { id: DemoId; label: string; blurb: string }[] = [
  { id: "voice", label: "Voice", blurb: "Hands-free, and it waits while you think" },
  { id: "web", label: "Web answers", blurb: "Live search, every claim cited" },
  { id: "docs", label: "Your documents", blurb: "Ask across the files you upload" },
  { id: "deep", label: "Deep research", blurb: "Multi-step research you can watch" },
  { id: "agents", label: "Voice agents", blurb: "Click one to hear it speak" },
];

// ── Script runtime ─────────────────────────────────────────────────────────
interface VoiceView {
  state: VoiceVizState;
  heard: string;
  status: string;
  /** The endpointer's verdict on what was heard so far, shown as a tag. */
  verdict?: { text: string; tone: "hold" | "go" };
}

interface DemoView {
  composer: string;
  turns: ChatTurn[];
  voice: VoiceView | null;
}

const EMPTY: DemoView = { composer: "", turns: [], voice: null };

class Cancelled extends Error {}

interface Ctl {
  wait: (ms: number) => Promise<void>;
  set: (fn: (v: DemoView) => DemoView) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(t);
      reject(new Cancelled());
    }, { once: true });
  });

let idSeq = 0;
const nextId = () => `demo-${++idSeq}`;

async function typeInto(ctl: Ctl, text: string, perChar = 26) {
  for (let i = 1; i <= text.length; i++) {
    ctl.set((v) => ({ ...v, composer: text.slice(0, i) }));
    await ctl.wait(perChar);
  }
}

/** User turn → retrieval steps → streamed, cited answer. */
async function chatScript(
  ctl: Ctl,
  q: { ask: string; mode: ChatTurn["mode"]; tools: ChatTurn["tools"]; answer: string; sources: Source[] },
) {
  await ctl.wait(500);
  await typeInto(ctl, q.ask);
  await ctl.wait(380);

  const assistantId = nextId();
  const startedAt = Date.now();
  ctl.set((v) => ({
    ...v,
    composer: "",
    turns: [
      { id: nextId(), role: "user", content: q.ask, timestamp: startedAt },
      { id: assistantId, role: "assistant", content: "", timestamp: startedAt, status: "streaming", mode: q.mode, tools: [], startedAt },
    ],
  }));
  const patch = (fn: (t: ChatTurn) => ChatTurn) =>
    ctl.set((v) => ({ ...v, turns: v.turns.map((t) => (t.id === assistantId ? fn(t) : t)) }));

  await ctl.wait(650);
  for (const tool of q.tools ?? []) {
    patch((t) => ({ ...t, tools: [...(t.tools ?? []), { ...tool, startedAt: Date.now() }] }));
    await ctl.wait(q.mode === "deep" ? 1150 : 1400);
  }

  // Stream word by word, the way tokens arrive.
  const words = q.answer.split(/(?<=\s)/);
  let shown = "";
  for (const w of words) {
    shown += w;
    const content = shown;
    patch((t) => ({ ...t, content }));
    await ctl.wait(34);
  }
  patch((t) => ({ ...t, status: "complete", sources: q.sources, endedAt: Date.now() }));
}

const SCRIPTS: Record<Exclude<DemoId, "agents">, (ctl: Ctl) => Promise<void>> = {
  voice: async (ctl) => {
    const say = (voice: VoiceView) => ctl.set((v) => ({ ...v, voice }));
    say({ state: "idle", heard: "", status: "Tap the orb and just talk" });
    await ctl.wait(900);
    const first = "What's the capital of";
    for (let i = 1; i <= first.split(" ").length; i++) {
      say({ state: "listening", heard: first.split(" ").slice(0, i).join(" "), status: "Listening…" });
      await ctl.wait(260);
    }
    say({
      state: "understanding", heard: `${first}…`, status: "Listening…",
      verdict: { text: "Unfinished sentence — holding the mic", tone: "hold" },
    });
    await ctl.wait(1900);
    say({
      state: "listening", heard: `${first}… France?`, status: "Listening…",
      verdict: { text: "Unfinished sentence — holding the mic", tone: "hold" },
    });
    await ctl.wait(700);
    say({
      state: "understanding", heard: `${first}… France?`, status: "Got it",
      verdict: { text: "Complete question — answering after 700 ms", tone: "go" },
    });
    await ctl.wait(1200);
    say({ state: "thinking", heard: `${first}… France?`, status: "Thinking…" });
    await ctl.wait(900);
    say({ state: "speaking", heard: "Paris. It's also France's largest city.", status: "Speaking · tap to interrupt" });
    await ctl.wait(3600);
    say({ state: "listening", heard: "", status: "Your turn — I'm listening" });
  },

  web: (ctl) =>
    chatScript(ctl, {
      ask: "How is Whisper large-v3-turbo different from large-v3?",
      mode: "web",
      tools: [{ name: "search_web", query: "Whisper large-v3-turbo vs large-v3 decoder layers speed" }],
      answer:
        "**large-v3-turbo** is a pruned version of large-v3: the decoder goes from **32 layers to 4** [1], " +
        "which makes it several times faster with only a small loss in accuracy [2]. The encoder is unchanged, " +
        "so it keeps large-v3's multilingual coverage [1].\n\n" +
        "faster-whisper can run it with int8 quantization, which cuts memory enough for a small laptop GPU [3].",
      sources: [
        { n: 1, type: "web", label: "openai/whisper-large-v3-turbo · Model card", url: "https://huggingface.co/openai/whisper-large-v3-turbo" },
        { n: 2, type: "web", label: "openai/whisper — Robust speech recognition", url: "https://github.com/openai/whisper" },
        { n: 3, type: "web", label: "SYSTRAN/faster-whisper — Faster Whisper with CTranslate2", url: "https://github.com/SYSTRAN/faster-whisper" },
      ],
    }),

  docs: (ctl) =>
    chatScript(ctl, {
      ask: "Where do the board deck and my research notes disagree?",
      mode: "web",
      tools: [
        { name: "search_documents", query: "market growth projection board deck" },
        { name: "search_documents", query: "addressable market estimate research notes" },
      ],
      answer:
        "They disagree on growth. The board deck projects **40% year-on-year growth** [1], " +
        "but your research notes estimate the addressable market grows about **18% a year** [2] — " +
        "so the deck assumes you more than double your market share.\n\n" +
        "The notes also flag the deck's churn figure as pre-pricing-change [3].",
      sources: [
        { n: 1, type: "document", label: "Q3-board-deck.pdf p.31", doc_name: "Q3-board-deck.pdf", page: 31 },
        { n: 2, type: "document", label: "research-notes.docx p.4", doc_name: "research-notes.docx", page: 4 },
        { n: 3, type: "document", label: "research-notes.docx p.7", doc_name: "research-notes.docx", page: 7 },
      ],
    }),

  deep: (ctl) =>
    chatScript(ctl, {
      ask: "Compare faster-whisper and whisper.cpp for a laptop GPU",
      mode: "deep",
      tools: [
        { name: "search_web", query: "faster-whisper CTranslate2 int8 GPU performance" },
        { name: "search_web", query: "whisper.cpp GGML CUDA Metal backend" },
        { name: "search_web", query: "CTranslate2 quantization int8_float16" },
      ],
      answer:
        "Both run Whisper locally, but they're built differently:\n\n" +
        "- **faster-whisper** reimplements Whisper on CTranslate2, with int8 and float16 quantization on CPU and NVIDIA GPUs [1][3].\n" +
        "- **whisper.cpp** is a dependency-free C/C++ port on GGML, running on CPU, CUDA and Apple Metal [2].\n\n" +
        "On an NVIDIA laptop GPU, faster-whisper is the simpler path from Python; on a Mac, whisper.cpp's Metal backend is the natural fit [2].",
      sources: [
        { n: 1, type: "web", label: "SYSTRAN/faster-whisper", url: "https://github.com/SYSTRAN/faster-whisper" },
        { n: 2, type: "web", label: "ggml-org/whisper.cpp", url: "https://github.com/ggml-org/whisper.cpp" },
        { n: 3, type: "web", label: "OpenNMT/CTranslate2 — Quantization", url: "https://opennmt.net/CTranslate2/quantization.html" },
      ],
    }),
};

/** The voice demo's end state, shown straight away under reduced motion. */
const VOICE_STILL: VoiceView = {
  state: "idle",
  heard: "What's the capital of… France?",
  status: "Waited through the pause, answered when the question was complete",
  verdict: { text: "Complete question — answering after 700 ms", tone: "go" },
};

function usePlayback(id: DemoId, active: boolean, onDone: () => void) {
  const [view, setView] = useState<DemoView>(EMPTY);
  const [done, setDone] = useState(false);
  const [run, setRun] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    setDone(false);
    if (id === "agents") {
      setView(EMPTY);
      return;
    }
    // Reduced motion: no typing, no streaming — the finished result, at once.
    const still = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still && id === "voice") {
      setView({ ...EMPTY, voice: VOICE_STILL });
      setDone(true);
      return;
    }
    setView(EMPTY);
    if (!active && !still) return;
    const abort = new AbortController();
    const ctl: Ctl = {
      wait: still ? async () => {} : (ms) => sleep(ms, abort.signal),
      set: (fn) => { if (!abort.signal.aborted) setView(fn); },
    };
    SCRIPTS[id](ctl)
      .then(() => { setDone(true); doneRef.current(); })
      .catch((e) => { if (!(e instanceof Cancelled)) throw e; });
    return () => abort.abort();
  }, [id, active, run]);

  const replay = useCallback(() => setRun((r) => r + 1), []);
  return { view, done, replay };
}

// ── Voice agents: real system voices, really speaking ──────────────────────
/** Stand-ins for a browser that hasn't loaded (or doesn't have) system voices. */
const FALLBACK_VOICES: VoiceOption[] = [
  { name: "Microsoft Heera - English (India)", lang: "en-IN", offline: true },
  { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US", offline: false },
  { name: "Microsoft Ryan Online (Natural) - English (United Kingdom)", lang: "en-GB", offline: false },
  { name: "Microsoft Swara Online (Natural) - Hindi (India)", lang: "hi-IN", offline: false },
  { name: "Microsoft Katja Online (Natural) - German (Germany)", lang: "de-DE", offline: false },
  { name: "Microsoft Denise Online (Natural) - French (France)", lang: "fr-FR", offline: false },
];

function useDemoAgents(): VoiceAgent[] {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const read = () => {
      const seen = new Set<string>();
      setVoices(
        window.speechSynthesis.getVoices()
          .filter((v) => !seen.has(v.name) && seen.add(v.name))
          .map((v) => ({ name: v.name, lang: v.lang, offline: v.localService })),
      );
    };
    read();
    window.speechSynthesis.addEventListener("voiceschanged", read);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", read);
  }, []);
  return useMemo(() => topAgents(voicesToAgents(voices.length ? voices : FALLBACK_VOICES), 6), [voices]);
}

function AgentsPanel() {
  const agents = useDemoAgents();
  const [speaking, setSpeaking] = useState<string | null>(null);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const speak = (agent: VoiceAgent) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const english = agent.lang.toLowerCase().startsWith("en");
    const line = english
      ? `${greetingFor(agent.lang)} I'm ${agent.name}. Ask me anything, and I'll find the answer and cite my sources.`
      : `${greetingFor(agent.lang)} ${agent.name}.`;
    const u = new SpeechSynthesisUtterance(line);
    const voice = synth.getVoices().find((v) => v.name === agent.voiceName);
    if (voice) u.voice = voice;
    u.lang = agent.lang;
    u.onstart = () => setSpeaking(agent.id);
    u.onend = u.onerror = () => setSpeaking((s) => (s === agent.id ? null : s));
    synth.speak(u);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5">
        <h3 className="font-display text-2xl font-semibold text-foreground">Voice agents</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every voice installed on this device becomes an agent. Click one to hear it.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => speak(agent)}
            aria-label={`Hear ${agent.name}, ${agent.accent}`}
            className={cn(
              "group flex flex-col items-center rounded-2xl border px-3 pb-3.5 pt-2 text-center transition-colors",
              speaking === agent.id
                ? "border-primary/50 bg-primary/[0.07]"
                : "border-border/70 bg-card/40 hover:border-border hover:bg-card/80",
            )}
          >
            <AgentAvatar agent={agent} size={76} active={speaking === agent.id} speaking={speaking === agent.id} />
            <span className="mt-1 text-[14px] font-medium text-foreground">{agent.name}</span>
            <span className="text-[11.5px] text-muted-foreground">{agent.accent}</span>
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors group-hover:text-primary">
              <Volume2 className="size-3" /> {speaking === agent.id ? "Speaking…" : "Hear me"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Voice call ─────────────────────────────────────────────────────────────
function VoicePanel({ voice }: { voice: VoiceView | null }) {
  const stateRef = useRef<VoiceVizState>("idle");
  stateRef.current = voice?.state ?? "idle";
  // Synthetic mic level and speech pulse, shaped like real ones: syllable-rate
  // bursts while listening, a steadier cadence while speaking.
  const getLevel = useCallback(() => {
    const t = performance.now() / 1000;
    if (stateRef.current !== "listening") return 0;
    return Math.max(0, 0.35 + 0.35 * Math.sin(t * 9.3) * Math.sin(t * 2.1));
  }, []);
  const getSpeechPulse = useCallback(() => {
    const t = performance.now() / 1000;
    return stateRef.current === "speaking" ? 0.5 + 0.5 * Math.abs(Math.sin(t * 6.2)) : 0;
  }, []);

  const state = voice?.state ?? "idle";
  return (
    <div className="flex h-full flex-col items-center justify-between py-2">
      <div className="font-display text-base font-semibold text-foreground">Nexus</div>
      <div className="relative flex w-full flex-1 items-center justify-center">
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute aspect-square w-[300px] rounded-full blur-[90px] transition-opacity duration-700",
            state === "speaking" ? "bg-primary/25 opacity-80" : state === "listening" ? "bg-accent/20 opacity-70" : "bg-primary/15 opacity-50",
          )}
        />
        <VoiceOrb state={state} getLevel={getLevel} getSpeechPulse={getSpeechPulse} className="relative aspect-square h-[230px] max-w-full" />
      </div>
      <div className="flex min-h-[86px] w-full max-w-md flex-col items-center gap-2 px-3 text-center">
        <p className="min-h-[1.6em] font-display text-[17px] leading-snug text-foreground">
          {voice?.heard ? `“${voice.heard}”` : ""}
        </p>
        {voice?.verdict ? (
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] font-medium",
              voice.verdict.tone === "go"
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {voice.verdict.text}
          </span>
        ) : null}
        <p className={cn("text-[13px]", state === "listening" ? "text-primary" : "text-muted-foreground")}>
          {voice?.status ?? ""}
        </p>
      </div>
      <div className="mt-3 flex items-center gap-5" aria-hidden>
        <span className="flex size-11 items-center justify-center rounded-full border border-border bg-muted/70 text-foreground"><Mic className="size-5" /></span>
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive text-destructive-foreground"><PhoneOff className="size-5" /></span>
        <span className="flex size-11 items-center justify-center rounded-full border border-border bg-muted/70 text-foreground"><Volume2 className="size-5" /></span>
      </div>
    </div>
  );
}

// ── Chat ───────────────────────────────────────────────────────────────────
function ChatPanel({ view, demo }: { view: DemoView; demo: DemoId }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.turns]);

  const empty = view.turns.length === 0;
  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="lp-demo-scroll min-h-0 flex-1 overflow-y-auto pr-1">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <h3 className="font-display text-[34px] font-semibold tracking-tight text-foreground">
              <span className="mr-2 text-primary">✳</span>Good afternoon
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">Ask anything — or just start talking.</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[640px] flex-col gap-6 pb-2">
            {view.turns.map((t) => <MessageItem key={t.id} turn={t} />)}
          </div>
        )}
      </div>

      {/* Composer, as in the app: text field over a tool row. */}
      <div className="mx-auto mt-3 w-full max-w-[640px] rounded-2xl border border-primary/30 bg-card/60 px-4 pb-3 pt-3.5 shadow-[0_0_0_1px_hsl(var(--primary)/0.06)]">
        <div className="min-h-[24px] text-[14.5px] text-foreground">
          {view.composer ? (
            <>
              {view.composer}
              <span className="ml-px inline-block h-[1.05em] w-[2px] animate-pulse bg-primary/80 align-text-bottom" />
            </>
          ) : (
            <span className="text-muted-foreground/70">Ask anything…</span>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2 text-muted-foreground" aria-hidden>
          <Plus className="size-4" />
          <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px]", demo === "docs" ? "border-primary/40 text-primary" : "border-border")}>
            <FileText className="size-3" /> Docs
          </span>
          <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px]", demo === "deep" ? "border-primary/40 text-primary" : "border-border")}>
            <Globe className="size-3" /> {demo === "deep" ? "Deep research" : "Web"}
          </span>
          <span className="ml-auto flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-white">
            <AudioLines className="size-4" />
          </span>
          <span className="flex size-8 items-center justify-center rounded-full bg-primary/30 text-foreground">
            <ArrowUp className="size-4" />
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────
const RECENTS: Record<DemoId, string[]> = {
  voice: ["Capital of France", "Whisper turbo vs large-v3", "Board deck vs notes"],
  web: ["Whisper turbo vs large-v3", "Capital of France", "Board deck vs notes"],
  docs: ["Board deck vs notes", "Whisper turbo vs large-v3", "Capital of France"],
  deep: ["faster-whisper vs whisper.cpp", "Whisper turbo vs large-v3", "Board deck vs notes"],
  agents: ["Capital of France", "Whisper turbo vs large-v3", "Board deck vs notes"],
};

function SideNav({ demo }: { demo: DemoId }) {
  const item = (icon: React.ReactNode, label: string, active: boolean) => (
    <div className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]", active ? "bg-muted/70 font-medium text-foreground" : "text-foreground/80")}>
      {icon}
      {label}
    </div>
  );
  return (
    <aside className="lp-demo-side flex w-[210px] shrink-0 flex-col border-r border-border/70 bg-card/30 px-2.5 py-3.5" aria-hidden>
      <div className="mb-3 flex items-center gap-2 px-1.5">
        <NexusLogo className="size-7 rounded-lg" />
        <span className="font-display text-[19px] font-semibold tracking-tight">
          nex<span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">us</span>
        </span>
      </div>
      {item(<Plus className="size-4" />, "New chat", demo !== "docs" && demo !== "agents")}
      {item(<FolderOpen className="size-4" />, "Documents", demo === "docs")}
      {item(<BriefcaseBusiness className="size-4" />, "N Projects", false)}
      {item(<AudioLines className="size-4" />, "Voice Agents", demo === "agents" || demo === "voice")}
      <div className="mt-4 px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Recents</div>
      {RECENTS[demo].map((r, i) => (
        <div key={r} className={cn("truncate rounded-lg px-2.5 py-1.5 text-[12.5px]", i === 0 ? "bg-muted/40 text-foreground" : "text-muted-foreground")}>
          {r}
        </div>
      ))}
      {demo === "docs" ? (
        <>
          <div className="mt-4 px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Documents</div>
          {["Q3-board-deck.pdf", "research-notes.docx"].map((d) => (
            <div key={d} className="flex items-center gap-2 truncate px-2.5 py-1.5 text-[12.5px] text-muted-foreground">
              <FileText className="size-3.5 shrink-0" />
              {d}
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-success" />
            </div>
          ))}
        </>
      ) : null}
    </aside>
  );
}

/** Auto-advances through the demos until the visitor picks one themselves. */
export function ProductDemo() {
  // `?demo=web` opens on a given demo and holds it, so a link can point at one.
  const linked = useMemo(() => {
    const q = new URLSearchParams(window.location.search).get("demo");
    return DEMOS.find((d) => d.id === q)?.id ?? null;
  }, []);
  const [demo, setDemo] = useState<DemoId>(linked ?? "voice");
  const [auto, setAuto] = useState(linked === null);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Read through a ref: a pick made while the hand-off timer is pending must
  // still cancel it.
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const advance = useCallback(() => {
    window.setTimeout(() => {
      if (!autoRef.current) return;
      setDemo((d) => {
        const i = DEMOS.findIndex((x) => x.id === d);
        return DEMOS[(i + 1) % DEMOS.length].id;
      });
    }, 3200);
  }, []);

  const { view, done, replay } = usePlayback(demo, visible, advance);

  // The agents panel has nothing to play; give it a moment, then move on.
  useEffect(() => {
    if (demo !== "agents" || !auto || !visible) return;
    const t = window.setTimeout(() => setDemo("voice"), 7000);
    return () => window.clearTimeout(t);
  }, [demo, auto, visible]);

  const pick = (id: DemoId) => {
    setAuto(false);
    if (id === demo) replay();
    else setDemo(id);
  };

  const current = DEMOS.find((d) => d.id === demo)!;

  return (
    <div ref={rootRef} className="lp-demo">
      <div className="lp-tabs" role="tablist" aria-label="Product demos">
        {DEMOS.map((d) => (
          <button
            key={d.id}
            className="lp-tab"
            role="tab"
            aria-selected={demo === d.id}
            onClick={() => pick(d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="lp-stage">
        <div className="lp-window">
          <div className="lp-window-bar">
            <span className="lp-dot" /><span className="lp-dot" /><span className="lp-dot" />
            <span className="lp-addr">{current.blurb}</span>
            {done && demo !== "agents" ? (
              <button type="button" className="lp-replay" onClick={replay} aria-label="Replay this demo">
                <RotateCcw size={13} /> Replay
              </button>
            ) : (
              <span className="lp-bar-spacer" />
            )}
          </div>
          {/* The app's own theme tokens apply inside: this is the real UI. */}
          <div className="lp-app dark flex bg-background text-foreground">
            <SideNav demo={demo} />
            <main className="min-w-0 flex-1 px-5 py-5 sm:px-8">
              {demo === "agents" ? (
                <AgentsPanel />
              ) : demo === "voice" ? (
                <VoicePanel voice={view.voice} />
              ) : (
                <ChatPanel view={view} demo={demo} />
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
