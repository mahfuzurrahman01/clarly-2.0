"use client";

import {
  AlertTriangle,
  Ban,
  CircleHelp,
  PackageCheck,
  PackageSearch,
  Tag,
  Truck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { ShipmentStatus } from "@/lib/api/delivery";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { shipmentStatusLabel } from "./format";

type Tone = "neutral" | "moving" | "done" | "warn" | "stopped";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-secondary text-muted-foreground",
  moving: "border-border bg-card text-foreground",
  done: "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  stopped: "border-destructive/40 bg-destructive/5 text-destructive",
};

const PRESENTATION: Record<ShipmentStatus, { tone: Tone; icon: LucideIcon }> = {
  label_created: { tone: "neutral", icon: Tag },
  picked_up: { tone: "moving", icon: PackageSearch },
  in_transit: { tone: "moving", icon: Truck },
  out_for_delivery: { tone: "moving", icon: Truck },
  delivered: { tone: "done", icon: PackageCheck },
  failed_attempt: { tone: "warn", icon: AlertTriangle },
  returned: { tone: "stopped", icon: Undo2 },
  cancelled: { tone: "stopped", icon: Ban },
  exception: { tone: "warn", icon: AlertTriangle },
  unknown: { tone: "neutral", icon: CircleHelp },
};

/**
 * Colour alone never carries the state — every badge is an icon *and* a word,
 * the same rule the catalog's stock badge follows. A support agent reading
 * this over someone's shoulder should not have to remember what amber means.
 */
export function ShipmentStatusBadge({
  status,
  className,
}: {
  status: ShipmentStatus;
  className?: string;
}) {
  const t = useTranslations();
  const { tone, icon: Icon } = PRESENTATION[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {shipmentStatusLabel(t, status)}
    </span>
  );
}
