import { useCallback, useEffect, useState } from "react";
import {
  deleteDocument,
  listDocuments,
  uploadDocuments,
  type DocumentMeta,
} from "@/lib/api";
import { debugLog } from "@/lib/config";
import { supabaseEnabled } from "@/lib/supabase";

export interface UseDocumentsReturn {
  documents: DocumentMeta[];
  uploading: boolean;
  error: string | null;
  readyCount: number;
  /** Refetch for the current identity — call after sign-in/out. */
  refresh: () => Promise<void>;
  addFiles: (files: FileList | File[]) => Promise<void>;
  remove: (docId: string) => Promise<void>;
  clearError: () => void;
  /** Show a message in the documents error slot — for a refusal decided
   *  before any request is made, such as a key that cannot upload. */
  reportError: (message: string) => void;
  // Selection: which ready documents the AI grounds on. NOTHING is selected by
  // default — a freshly uploaded doc auto-selects, and New chat clears it.
  isSelected: (docId: string) => boolean;
  toggleSelected: (docId: string) => void;
  resetSelection: () => void;
  activeDocIds: string[];
  activeDocNames: string[];
}

const ACCEPTED = /\.(pdf|docx|txt|md|markdown|text|log|csv)$/i;

export function useDocuments(): UseDocumentsReturn {
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // We track explicitly SELECTED ids; nothing is grounded until the user picks
  // a document (or uploads one, which auto-selects).
  const [selected, setSelected] = useState<string[]>([]);

  /** Refetch the caller's documents. Also used when signing in or out changes
   *  the server-side owner, which changes which documents exist. */
  const refresh = useCallback(async () => {
    try {
      setDocuments(await listDocuments());
    } catch (e) {
      debugLog("listDocuments failed", e);
    }
  }, []);

  // Load anything already ingested for this identity (e.g. after reload).
  //
  // Only when there is no Supabase project to wait for. With one configured,
  // the access token does not exist yet on first render — Supabase resolves the
  // stored session asynchronously — so fetching here is a guaranteed 401 before
  // the real request even goes out. `useAuth` calls `refresh()` on every auth
  // event, and `INITIAL_SESSION` fires as soon as that resolution completes,
  // which is the earliest moment the call can actually succeed.
  useEffect(() => {
    if (supabaseEnabled) return;
    void refresh();
  }, [refresh]);

  const addFiles = useCallback(async (input: FileList | File[]) => {
    const all = Array.from(input);
    const files = all.filter((f) => ACCEPTED.test(f.name));
    const rejected = all.length - files.length;
    if (rejected > 0) {
      setError(
        `${rejected} file${rejected > 1 ? "s" : ""} skipped — only PDF, DOCX, TXT and MD are supported.`,
      );
    }
    if (files.length === 0) return;

    // Optimistic placeholders so the UI shows the file immediately while it ingests.
    const placeholders: DocumentMeta[] = files.map((f) => ({
      doc_id: `pending_${f.name}_${f.size}`,
      name: f.name,
      size: f.size,
      status: "processing",
      n_chunks: 0,
      pages: [],
    }));
    setDocuments((d) => [...d, ...placeholders]);
    setUploading(true);
    try {
      const ingested = await uploadDocuments(files);
      // Replace placeholders with the real metadata from the server.
      setDocuments((d) => {
        const withoutPlaceholders = d.filter((x) => !x.doc_id.startsWith("pending_"));
        return [...withoutPlaceholders, ...ingested];
      });
      // Auto-select what the user just uploaded — they clearly intend to use it.
      const readyIds = ingested.filter((x) => x.status === "ready").map((x) => x.doc_id);
      if (readyIds.length) {
        setSelected((s) => Array.from(new Set([...s, ...readyIds])));
      }
      const failed = ingested.filter((x) => x.status === "error");
      if (failed.length) {
        setError(`${failed[0].name}: ${failed[0].error ?? "could not be processed."}`);
      }
    } catch (e) {
      setDocuments((d) => d.filter((x) => !x.doc_id.startsWith("pending_")));
      setError((e as Error).message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  }, []);

  const remove = useCallback(async (docId: string) => {
    const prev = documents;
    setDocuments((d) => d.filter((x) => x.doc_id !== docId));
    setSelected((s) => s.filter((id) => id !== docId));
    try {
      await deleteDocument(docId);
    } catch (e) {
      debugLog("delete failed", e);
      setDocuments(prev); // restore on failure
    }
  }, [documents]);

  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((message: string) => setError(message), []);

  const isSelected = useCallback((docId: string) => selected.includes(docId), [selected]);
  const toggleSelected = useCallback((docId: string) => {
    setSelected((s) => (s.includes(docId) ? s.filter((x) => x !== docId) : [...s, docId]));
  }, []);
  const resetSelection = useCallback(() => setSelected([]), []);

  const readyCount = documents.filter((d) => d.status === "ready").length;
  const activeDocs = documents.filter(
    (d) => d.status === "ready" && selected.includes(d.doc_id),
  );
  const activeDocIds = activeDocs.map((d) => d.doc_id);
  /** Titles of the grounded documents. Speech recognition uses these to bias
   *  decoding: someone who just selected a report is about to say its name and
   *  the proper nouns inside it. */
  const activeDocNames = activeDocs.map((d) => d.name);

  return {
    documents,
    uploading,
    error,
    readyCount,
    refresh,
    addFiles,
    remove,
    clearError,
    reportError,
    isSelected,
    toggleSelected,
    resetSelection,
    activeDocIds,
    activeDocNames,
  };
}
