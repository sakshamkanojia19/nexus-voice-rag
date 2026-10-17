import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, FileText, Info, KeyRound, Loader2, Plus, Trash2, UploadCloud, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UseDocumentsReturn } from "@/hooks/useDocuments";

function fmtSize(b: number): string {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

interface DocumentsPageProps {
  docs: UseDocumentsReturn;
  onClose: () => void;
  /** Why the current key cannot upload, or null when it can. Shown up front,
   *  so nobody finds out by watching an upload fail. */
  uploadBlocked?: string | null;
  /** Opens the API key panel — the way out of uploadBlocked. */
  onManageKey?: () => void;
}

export function DocumentsPage({ docs, onClose, uploadBlocked, onManageKey }: DocumentsPageProps) {
  const { documents, error, addFiles, remove, clearError, isSelected, toggleSelected } = docs;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files); }}
    >
      <div className="mb-7 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Documents · {documents.length}
          </div>
          <h2 className="font-display text-3xl font-semibold">Your <span className="text-gradient">documents</span></h2>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <X className="size-5" />
        </button>
      </div>

      {uploadBlocked ? (
        <div className="mb-4 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1 leading-relaxed text-foreground/90">
            <span className="font-medium text-foreground">Documents work with an OpenAI key.</span>{" "}
            Searching your files needs embeddings, which only OpenAI provides — your current key
            still handles chat, web search and voice.
          </p>
          {onManageKey ? (
            <button
              type="button"
              onClick={onManageKey}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 px-2.5 py-1 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <KeyRound className="size-3.5" /> Add an OpenAI key
            </button>
          ) : null}
        </div>
      ) : null}

      <AnimatePresence>
        {error && error !== uploadBlocked ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={clearError} aria-label="Dismiss"><X className="size-4" /></button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {/* Upload card */}
        <button
          onClick={() => (uploadBlocked ? onManageKey?.() : inputRef.current?.click())}
          title={uploadBlocked ?? undefined}
          className={cn(
            "flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center transition-all",
            uploadBlocked
              ? "border-border/60 bg-card/50 opacity-70 hover:opacity-100"
              : dragging ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50 hover:bg-muted/40",
          )}
        >
          <div className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
            {dragging ? <UploadCloud className="size-5" /> : <Plus className="size-5" />}
          </div>
          <div className="text-sm font-medium text-foreground">{dragging ? "Drop to upload" : "New document"}</div>
          <div className="text-[11px] text-muted-foreground">
            {uploadBlocked ? "Needs an OpenAI key" : "PDF · DOCX · TXT · MD"}
          </div>
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.markdown,.text,.log,.csv"
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) void addFiles(e.target.files); e.target.value = ""; }}
        />

        {/* Document cards */}
        <AnimatePresence initial={false}>
          {documents.map((d) => {
            const selectable = d.status === "ready";
            const selected = selectable && isSelected(d.doc_id);
            return (
              <motion.div
                key={d.doc_id}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                onClick={() => selectable && toggleSelected(d.doc_id)}
                className={cn(
                  "group relative flex aspect-[4/3] cursor-pointer flex-col justify-between rounded-2xl border p-4 transition-all",
                  selected ? "border-primary/60 bg-primary/10 shadow-glow" : "border-border bg-card hover:border-primary/40",
                )}
              >
                <div className="flex items-start justify-between">
                  {d.status === "processing" ? (
                    <Loader2 className="size-7 animate-spin text-warning" />
                  ) : d.status === "error" ? (
                    <AlertCircle className="size-7 text-destructive" />
                  ) : (
                    <FileText className="size-7 text-primary" />
                  )}
                  <div className="flex items-center gap-1.5">
                    {selectable ? (
                      <span className={cn(
                        "grid size-5 place-items-center rounded-md border transition-colors",
                        selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                      )}>
                        {selected ? <Check className="size-3" /> : null}
                      </span>
                    ) : null}
                    {!d.doc_id.startsWith("pending_") ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); void remove(d.doc_id); }}
                        aria-label={`Remove ${d.name}`}
                        title="Remove"
                        className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
                <div>
                  <div className="truncate text-sm font-medium text-foreground" title={d.name}>{d.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {d.status === "error" ? (d.error || "Failed")
                      : d.status === "processing" ? "Processing…"
                      : `${d.n_chunks} chunk${d.n_chunks === 1 ? "" : "s"}${d.size ? ` · ${fmtSize(d.size)}` : ""}`}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {documents.length === 0 ? (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          No documents yet — upload one to ground your answers. Ticked documents are the ones the AI will use.
        </p>
      ) : null}
    </motion.div>
  );
}
