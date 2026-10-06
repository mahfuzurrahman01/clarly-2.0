"use client";

import { useTranslations } from "@/lib/i18n/provider";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { cn } from "@/lib/utils";

/**
 * Feature 18: the customer's label, shown as a coloured chip in the inbox list.
 *
 * - hot:   red — the customer explicitly asked for a human or is distressed.
 * - warm:  amber — the agent couldn't answer (KB gap, low confidence).
 * - cold:  green — the agent answered successfully.
 *
 * A null or unknown label renders nothing — the row simply has no chip.
 */
type LeadLabel = "hot" | "warm" | "cold";

const LABEL_STYLES: Record<LeadLabel, { bg: string; text: string; dot: string }> = {
  hot: {
    bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800",
    text: "text-red-700 dark:text-red-300",
    dot: "bg-red-500",
  },
  warm: {
    bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  cold: {
    bg: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800",
    text: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

/** Short word on the chip, full phrase for screen readers ("Hot" reads as a temperature on its own). */
function labelText(label: LeadLabel, t: Dictionary): { short: string; full: string } {
  switch (label) {
    case "hot":
      return { short: t.inbox.leadHot, full: t.inbox.leadHotFull };
    case "warm":
      return { short: t.inbox.leadWarm, full: t.inbox.leadWarmFull };
    case "cold":
      return { short: t.inbox.leadCold, full: t.inbox.leadColdFull };
  }
}

function isLeadLabel(value: string): value is LeadLabel {
  return Object.hasOwn(LABEL_STYLES, value);
}

export function LabelChip({
  label,
  className,
}: {
  label: string | null;
  className?: string;
}) {
  const t = useTranslations();
  if (!label || !isLeadLabel(label)) return null;

  const styles = LABEL_STYLES[label];
  const text = labelText(label, t);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        styles.bg,
        styles.text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", styles.dot)}
      />
      <span aria-hidden="true">{text.short}</span>
      <span className="sr-only">{text.full}</span>
    </span>
  );
}
