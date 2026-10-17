import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names with conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** ISO date (yyyy-mm-dd) for today, local time. */
export function todayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/** Add n days to a date and return ISO date. */
export function addDaysISO(base: Date, n: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Human-readable relative due ("today", "in 3 days", "2 days overdue"). */
export function relativeDue(dueISO: string): { label: string; tone: "ok" | "soon" | "overdue" } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueISO + "T00:00:00");
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return { label: `${Math.abs(diffDays)}d overdue`, tone: "overdue" };
  if (diffDays === 0) return { label: "due today", tone: "soon" };
  if (diffDays === 1) return { label: "due tomorrow", tone: "soon" };
  if (diffDays <= 3) return { label: `in ${diffDays} days`, tone: "soon" };
  return { label: `in ${diffDays} days`, tone: "ok" };
}
