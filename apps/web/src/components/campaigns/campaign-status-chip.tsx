"use client";

import {
  BadgeCheck,
  Ban,
  CalendarClock,
  CircleSlash,
  FileWarning,
  Hand,
  PencilLine,
  Send,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CampaignStatus } from "@/lib/api/campaigns";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Ten statuses, ten chips — and in particular FOUR distinct paused states,
 * never one grey "Paused".
 *
 *   paused_spend_cap    the tenant's own budget ceiling — money, reversible
 *                       by raising the cap
 *   paused_eligibility  a fail-closed account gate tripped (verification,
 *                       health, quality, billing) — resuming without fixing
 *                       the account trips it again
 *   paused_template     Meta withdrew the template mid-send — fixed in
 *                       WhatsApp Manager, not here
 *   paused_manual       a human pressed Pause — nothing is wrong
 *
 * Each carries its own icon AND its own words, so the distinction survives a
 * monochrome screen and colour-blind readers.
 */
const STATUS_STYLE: Record<
  CampaignStatus,
  { icon: LucideIcon; className: string }
> = {
  draft: {
    icon: PencilLine,
    className: "border-dashed border-border text-muted-foreground",
  },
  scheduled: {
    icon: CalendarClock,
    className: "border-border bg-secondary text-foreground",
  },
  sending: {
    icon: Send,
    className: "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
  },
  paused_spend_cap: {
    icon: Wallet,
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  paused_eligibility: {
    icon: ShieldAlert,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  paused_template: {
    icon: FileWarning,
    className: "border-destructive/40 text-destructive",
  },
  paused_manual: {
    icon: Hand,
    className: "border-foreground/25 text-foreground",
  },
  completed: {
    icon: BadgeCheck,
    className: "border-lime-ring/40 text-lime-text",
  },
  canceled: {
    icon: Ban,
    className: "border-border text-muted-foreground",
  },
  failed: {
    icon: CircleSlash,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

export function useStatusLabel(): (status: CampaignStatus) => string {
  const t = useTranslations();
  return (status) =>
    ({
      draft: t.campaigns.status.draft,
      scheduled: t.campaigns.status.scheduled,
      sending: t.campaigns.status.sending,
      paused_spend_cap: t.campaigns.status.pausedSpendCap,
      paused_template: t.campaigns.status.pausedTemplate,
      paused_manual: t.campaigns.status.pausedManual,
      paused_eligibility: t.campaigns.status.pausedEligibility,
      completed: t.campaigns.status.completed,
      canceled: t.campaigns.status.canceled,
      failed: t.campaigns.status.failed,
    })[status];
}

export function CampaignStatusChip({
  status,
  size = "default",
}: {
  status: CampaignStatus;
  size?: "default" | "lg";
}) {
  const label = useStatusLabel()(status);
  const { icon: Icon, className } = STATUS_STYLE[status];

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border font-medium",
        size === "lg"
          ? "px-3 py-1 text-sm"
          : "px-2 py-0.5 text-xs",
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-3.5" : "size-3"} aria-hidden />
      {label}
    </span>
  );
}
