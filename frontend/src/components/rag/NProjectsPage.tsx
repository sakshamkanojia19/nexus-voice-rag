import { motion } from "framer-motion";
import { ArrowLeft, BriefcaseBusiness, X } from "lucide-react";

interface NProjectsPageProps {
  onClose: () => void;
}

/**
 * N Projects hasn't shipped yet. This page says so plainly and professionally:
 * one clear statement, a short description of what's being built, and a way
 * back — no mock data pretending to be a product.
 */
export function NProjectsPage({ onClose }: NProjectsPageProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10"
    >
      <div className="mb-7 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            N Projects
          </div>
          <h2 className="font-display text-3xl font-semibold">
            N <span className="text-gradient">Projects</span>
          </h2>
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

      <div className="flex flex-1 items-start justify-center pt-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card/70 px-8 py-12 text-center shadow-soft">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <BriefcaseBusiness className="size-7" />
          </div>

          <h3 className="mt-6 font-display text-2xl font-semibold text-foreground">Coming soon</h3>
          <p className="mx-auto mt-2 text-sm text-muted-foreground">
            We're crafting this — check back shortly.
          </p>

          <button
            onClick={onClose}
            className="mt-9 inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to chat
          </button>
        </div>
      </div>
    </motion.div>
  );
}
