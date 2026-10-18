import { Children, memo, useMemo, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Check, Copy, Square, Volume2 } from "lucide-react";
import { NexusMark } from "@/components/brand/NexusLogo";
import { cn } from "@/lib/utils";
import type { ChatTurn } from "@/hooks/useChat";
import type { Source } from "@/lib/api";
import { useSmoothText } from "@/hooks/useSmoothText";
import { canSplit, splitBlocks, stabilizeTail } from "@/lib/stream-markdown";
import { AnswerSkeleton, SearchActivity } from "./SearchActivity";
import { Sources } from "./Sources";

// ── Citations: turn [n] tokens inside text into chips ────────────────────────
// Neutral at rest so a densely-cited paragraph still reads as prose; the violet
// only appears under the cursor, where it signals "this is a link".
function CitationChip({ n, source }: { n: number; source?: Source }) {
  const title = source ? `${source.label}${source.snippet ? ` — ${source.snippet}` : ""}` : `Source ${n}`;
  const cls =
    "mx-[1px] inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-muted px-1 align-[1px] font-sans text-[10.5px] font-medium leading-none tabular-nums text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary";
  if (source?.url) {
    return (
      <a href={source.url} target="_blank" rel="noopener noreferrer" title={title} className={cls}>
        {n}
      </a>
    );
  }
  return (
    <span title={title} className={cls}>
      {n}
    </span>
  );
}

/** Replace [n] tokens inside string children with citation chips (leaves elements untouched). */
function withCitations(children: ReactNode, sources: Source[] | undefined): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts = child.split(/(\[\d+\])/g);
    if (parts.length === 1) return child;
    return parts.map((part, i) => {
      const m = /^\[(\d+)\]$/.exec(part);
      if (m) {
        const n = parseInt(m[1], 10);
        return <CitationChip key={i} n={n} source={sources?.find((s) => s.n === n)} />;
      }
      return part;
    });
  });
}

// ── Code block (ChatGPT/CiteTalk style: header + Copy + monospace) ───────────
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border/70 bg-background/70 font-sans">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">{lang || "text"}</span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        <code className="whitespace-pre font-mono text-foreground/90">{code}</code>
      </pre>
    </div>
  );
}

// ── Markdown renderer ────────────────────────────────────────────────────────
const REMARK_PLUGINS = [remarkGfm];

/**
 * Element renderers, built once per sources list. They must keep their
 * identity between renders: an inline `components={{...}}` object is a new set
 * of component types every time, and React then unmounts and rebuilds every
 * paragraph, table and chip in the answer on every streamed token.
 */
function makeComponents(sources: Source[] | undefined): Components {
  const cite = (c: ReactNode) => withCitations(c, sources);
  return {
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{cite(children)}</p>,
    h1: ({ children }) => <h1 className="mb-2 mt-4 text-2xl font-semibold first:mt-0">{cite(children)}</h1>,
    h2: ({ children }) => <h2 className="mb-2 mt-4 text-xl font-semibold first:mt-0">{cite(children)}</h2>,
    h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-lg font-semibold first:mt-0">{cite(children)}</h3>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground/50">{children}</ul>,
    ol: ({ children, start }) => (
      <ol start={start} className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground/60">{children}</ol>
    ),
    li: ({ children }) => <li>{cite(children)}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{cite(children)}</strong>,
    em: ({ children }) => <em className="italic">{cite(children)}</em>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground underline decoration-border underline-offset-[3px] transition-colors hover:decoration-primary/70 hover:text-primary"
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-foreground/75">{children}</blockquote>
    ),
    hr: () => <hr className="my-4 border-border/70" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse font-sans text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => <th className="border border-border bg-muted/40 px-2 py-1 text-left font-semibold">{cite(children)}</th>,
    td: ({ children }) => <td className="border border-border px-2 py-1">{cite(children)}</td>,
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      // An empty fence (a block that has only just opened mid-stream) has no
      // children at all; String(undefined) would render the word "undefined".
      const raw = String(children ?? "").replace(/\n$/, "");
      const match = /language-(\w+)/.exec(className || "");
      const isBlock = !!match || raw.includes("\n");
      if (!isBlock) {
        return <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>;
      }
      return <CodeBlock code={raw} lang={match?.[1]} />;
    },
  };
}

/** One top-level block. Memoized on its text, so a finished paragraph is parsed
 *  once and then left alone while later ones stream in. */
const MarkdownBlock = memo(function MarkdownBlock({ md, components }: { md: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {md}
    </ReactMarkdown>
  );
});

function Markdown({ text, sources, streaming }: { text: string; sources?: Source[]; streaming: boolean }) {
  const components = useMemo(() => makeComponents(sources), [sources]);
  // Rendered the same way while streaming and after, so the last token does
  // not swap one DOM tree for another and nudge the layout.
  const blocks = canSplit(text) ? splitBlocks(text) : [text];
  // No wrapper per block: ReactMarkdown renders bare elements, so the blocks'
  // paragraphs, lists and tables end up siblings exactly as in one big render,
  // and the first:/last: margin rules still see the real first and last child.
  return (
    <>
      {blocks.map((md, i) => {
        const shown = streaming && i === blocks.length - 1 ? stabilizeTail(md) : md;
        return shown ? <MarkdownBlock key={i} md={shown} components={components} /> : null;
      })}
    </>
  );
}

// ── Which model answered ─────────────────────────────────────────────────────
const PROVIDER_NAMES: Record<string, string> = { openai: "OpenAI", xai: "Grok", groq: "Groq" };

/** "openai/gpt-oss-20b" on Groq → "gpt-oss-20b · Groq". The vendor prefix is
 *  Groq's namespacing, not information; the provider is what the user chose. */
function modelLabel(model: string, provider?: string): string {
  const name = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const via = provider ? PROVIDER_NAMES[provider] : undefined;
  return via && via !== "OpenAI" ? `${name} · ${via}` : name;
}

// ── Message actions ──────────────────────────────────────────────────────────
const actionCls =
  "inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy message"
      className={actionCls}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label ? <span className="text-[11px]">{copied ? "Copied" : label}</span> : null}
    </button>
  );
}

// ── Message item ─────────────────────────────────────────────────────────────
export const MessageItem = memo(function MessageItem({
  turn,
  onSpeak,
  speaking,
}: {
  turn: ChatTurn;
  /** Toggle read-aloud for this message: starts it, or stops it if it's playing. */
  onSpeak?: (turn: ChatTurn) => void;
  /** True while THIS message is the one being read. */
  speaking?: boolean;
}) {
  const isUser = turn.role === "user";
  const isError = turn.status === "error";
  const streaming = turn.status === "streaming";
  // Hooks before the early returns below.
  const displayed = useSmoothText(turn.content, streaming && !isUser);

  if (isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="group flex w-full flex-col items-end gap-1"
      >
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-border/70 bg-muted/40 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-foreground">
          {turn.content}
        </div>
        <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <CopyButton text={turn.content} />
        </div>
      </motion.div>
    );
  }

  if (isError) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="flex w-full items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3 font-sans text-[13px] leading-relaxed text-destructive/90"
        role="alert"
      >
        <AlertCircle className="mt-px size-4 shrink-0" />
        <span className="min-w-0 flex-1">{turn.content}</span>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="group w-full"
    >
      <SearchActivity turn={turn} />

      {displayed ? (
        <div className="min-w-0 font-display text-[1.0625rem] leading-[1.75] text-foreground">
          <Markdown text={displayed} sources={turn.sources} streaming={streaming} />
        </div>
      ) : streaming ? (
        <AnswerSkeleton />
      ) : null}

      {turn.sources && turn.sources.length > 0 ? <Sources sources={turn.sources} /> : null}

      {!streaming && turn.content ? (
        <div className="mt-3 flex items-center gap-1 font-sans text-[11px] text-muted-foreground/70">
          <CopyButton text={turn.content} label="Copy" />
          {onSpeak ? (
            <button
              onClick={() => onSpeak(turn)}
              title={speaking ? "Stop reading" : "Read aloud"}
              aria-label={speaking ? "Stop reading" : "Read aloud"}
              // `aria-pressed` rather than a second button: to a screen reader
              // this is one control whose state changed, which is what it is.
              aria-pressed={speaking}
              className={cn(actionCls, speaking && "text-primary hover:text-primary")}
            >
              {speaking ? (
                // A filled square is the universal "stop". Swapping the glyph —
                // not just tinting it — is what makes the second click obviously
                // a different action rather than a repeat of the first.
                <Square className="size-3.5 fill-current" />
              ) : (
                <Volume2 className="size-3.5" />
              )}
              {speaking ? <span className="text-[11px]">Stop</span> : null}
            </button>
          ) : null}
          {turn.model ? (
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 pl-2"
              title={`Answered by ${turn.model}${turn.provider ? ` via ${PROVIDER_NAMES[turn.provider] ?? turn.provider}` : ""}`}
            >
              <NexusMark className="size-3 shrink-0 text-muted-foreground/60" />
              <span>{modelLabel(turn.model, turn.provider)}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
});
