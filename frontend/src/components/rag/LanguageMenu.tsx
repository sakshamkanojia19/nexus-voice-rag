import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGES, findLang } from "@/lib/languages";

interface LanguageMenuProps {
  value: string; // BCP-47 code
  onChange: (code: string) => void;
  /** "up" opens above the trigger (composer), "down" below (call screen). */
  direction?: "up" | "down";
  className?: string;
}

/** Conversation-language picker — sets what Nexus listens for AND replies in. */
export function LanguageMenu({ value, onChange, direction = "up", className }: LanguageMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = findLang(value);

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
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Conversation language — Nexus listens for and replies in this"
        aria-label="Choose language"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
          open && "border-primary/50 text-foreground",
        )}
      >
        <Globe className="size-3.5" />
        <span className="max-w-[90px] truncate">{current.label}</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div
          className={cn(
            "surface absolute right-0 z-50 w-56 overflow-hidden rounded-xl border border-border shadow-soft",
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Listen & reply in
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {LANGUAGES.map((l) => {
              const active = l.code === value;
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => {
                    onChange(l.code);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-primary/10",
                    active ? "text-primary" : "text-foreground/90",
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {active ? <Check className="size-3.5 text-primary" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{l.label}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{l.native}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
