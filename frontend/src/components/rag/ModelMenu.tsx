import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelMenuProps {
  models: string[];
  /** null = follow the server's default for the current search mode. */
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  disabledHint?: string;
}

/** Model ids are lowercase and dotted; the menu shows a tidied form but always
 *  sends the raw id, since that's what the server allowlist matches on. */
function labelFor(id: string): string {
  return id
    .replace(/^gpt-/, "GPT-")
    .replace(/^o(\d)/, "o$1")
    .replace(/-mini$/, " Mini")
    .replace(/-nano$/, " Nano");
}

export function ModelMenu({ models, value, onChange, disabled, disabledHint }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // Nothing to choose between — don't render a control that can't do anything.
  if (models.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? disabledHint : "Choose the model that answers"}
        aria-label="Choose model"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50",
          open && "border-primary/50 text-foreground",
        )}
      >
        <Sparkles className="size-3.5 shrink-0" />
        {/* On a phone the label is the widest thing in the row and the icon
            already identifies the control; the name still shows in the menu. */}
        <span className="hidden max-w-[92px] truncate sm:inline">{value ? labelFor(value) : "Auto"}</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="surface absolute bottom-full right-0 z-50 mb-2 w-52 overflow-hidden rounded-xl border border-border shadow-soft">
          <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Model
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <ModelRow
              label="Auto"
              hint="Match the search mode"
              active={value === null}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            />
            {models.map((id) => (
              <ModelRow
                key={id}
                label={labelFor(id)}
                active={value === id}
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelRow({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-primary/10",
        active ? "text-primary" : "text-foreground/90",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {active ? <Check className="size-3.5 text-primary" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-[10px] text-muted-foreground">{hint}</span> : null}
    </button>
  );
}
