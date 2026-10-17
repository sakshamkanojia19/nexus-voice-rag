import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocumentMeta } from "@/lib/api";

interface DocMenuProps {
  documents: DocumentMeta[];
  onAttachFiles?: (files: FileList) => void;
  onRemoveDoc: (docId: string) => void;
  isSelected: (docId: string) => boolean;
  onToggleSelect: (docId: string) => void;
}

function fmtSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The "Docs" chip in the search bar — opens a menu to choose (add) and remove documents. */
export function DocMenu({ documents, onAttachFiles, onRemoveDoc, isSelected, onToggleSelect }: DocMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = documents.filter((d) => d.status === "ready");
  const activeCount = ready.filter((d) => isSelected(d.doc_id)).length;
  const active = activeCount > 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Manage documents"
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
          active ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
          open && "border-primary/60",
        )}
      >
        <FileText className="size-3 shrink-0" />
        {/* A count is worth the width on any screen; the bare "Docs" label is
            not, since the icon says the same thing. */}
        <span className={activeCount > 0 ? "" : "hidden sm:inline"}>
          {activeCount > 0 ? `${activeCount} doc${activeCount > 1 ? "s" : ""}` : "Docs"}
        </span>
      </button>

      {open ? (
        <div className="surface absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border shadow-soft">
          <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Tick the documents the AI should use
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {documents.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                No documents yet — choose one to ground your answers.
              </p>
            ) : (
              documents.map((d) => {
                const selectable = d.status === "ready";
                const selected = selectable && isSelected(d.doc_id);
                return (
                  <div
                    key={d.doc_id}
                    className={cn(
                      "group flex items-center gap-2.5 px-2.5 py-2",
                      selectable && "cursor-pointer hover:bg-muted/40",
                    )}
                    onClick={() => selectable && onToggleSelect(d.doc_id)}
                  >
                    {/* selection checkbox / status */}
                    {d.status === "processing" ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-warning" />
                    ) : d.status === "error" ? (
                      <AlertCircle className="size-4 shrink-0 text-destructive" />
                    ) : (
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                        )}
                      >
                        {selected ? <Check className="size-3" /> : null}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-xs font-medium", selected || !selectable ? "text-foreground" : "text-muted-foreground")} title={d.name}>
                        {d.name}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {d.status === "error"
                          ? d.error || "Failed"
                          : d.status === "processing"
                            ? "Processing…"
                            : `${d.n_chunks} chunk${d.n_chunks === 1 ? "" : "s"}${d.size ? ` · ${fmtSize(d.size)}` : ""}`}
                      </div>
                    </div>
                    {!d.doc_id.startsWith("pending_") ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveDoc(d.doc_id);
                        }}
                        title="Remove document"
                        aria-label={`Remove ${d.name}`}
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <Plus className="size-4" /> Choose document
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.markdown,.text,.log,.csv"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) onAttachFiles?.(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
