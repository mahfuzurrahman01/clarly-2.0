"use client";

import Link from "next/link";
import { FileWarning, Hand, ShieldAlert, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PausedStatus } from "@/lib/api/campaigns";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fill, formatCount } from "./format";

/**
 * A paused campaign is not one state. Four different things stop a send and
 * each has a different fix, so each gets its own panel: what actually
 * happened, what the operator has to do, and — for the eligibility gate —
 * the warning that resuming without fixing the account will simply trip the
 * same check again.
 *
 * `pauseReason` is the sentence the backend recorded. It is shown verbatim
 * underneath the explanation rather than instead of it: it is precise but
 * written for an operator who already knows the model.
 */
type Presentation = {
  icon: LucideIcon;
  tone: string;
  rule: string;
  title: string;
  what: string;
  fix: string;
  /** Where the operator goes to actually fix it, when that is somewhere else. */
  action?: { href: string; label: string };
  /** True only for the gate that will re-trip if resumed unfixed. */
  warnOnResume?: boolean;
};

export function PauseExplainer({
  status,
  pauseReason,
  pendingCount,
}: {
  status: PausedStatus;
  pauseReason: string | null;
  pendingCount: number | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = t.campaigns.paused;

  const PRESENTATION: Record<PausedStatus, Presentation> = {
    paused_spend_cap: {
      icon: Wallet,
      tone: "text-amber-700 dark:text-amber-400",
      rule: "bg-amber-500",
      title: copy.spendCapTitle,
      what: copy.spendCapWhat,
      fix: copy.spendCapFix,
      // Deliberately NOT a "raise the cap" button: `PUT /campaigns/:id` is
      // draft-only, so a launched campaign's cap cannot be edited at all.
      // The honest next step is a fresh campaign for whoever is left.
      action: { href: "/campaigns/new", label: copy.spendCapAction },
    },
    paused_eligibility: {
      icon: ShieldAlert,
      tone: "text-destructive",
      rule: "bg-destructive",
      title: copy.eligibilityTitle,
      what: copy.eligibilityWhat,
      fix: copy.eligibilityFix,
      action: { href: "/settings/channels", label: copy.eligibilityAction },
      warnOnResume: true,
    },
    paused_template: {
      icon: FileWarning,
      tone: "text-destructive",
      rule: "bg-destructive/60",
      title: copy.templateTitle,
      what: copy.templateWhat,
      fix: copy.templateFix,
      action: { href: "/settings/templates", label: copy.templateAction },
    },
    paused_manual: {
      icon: Hand,
      tone: "text-foreground",
      rule: "bg-foreground/40",
      title: copy.manualTitle,
      what: copy.manualWhat,
      fix: copy.manualFix,
    },
  };

  const present = PRESENTATION[status];
  const Icon = present.icon;

  return (
    <section
      aria-labelledby="pause-explainer-title"
      className="relative overflow-hidden rounded-xl border border-border bg-card"
    >
      {/* A 3px inline-start rule, the one place the state's colour carries weight. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 start-0 w-[3px]",
          present.rule,
        )}
      />
      <div className="space-y-4 p-5 ps-6">
        <div className="flex items-start gap-3">
          <Icon className={cn("mt-0.5 size-4 shrink-0", present.tone)} aria-hidden />
          <div className="space-y-2">
            <h2
              id="pause-explainer-title"
              className={cn("font-display text-lg font-medium tracking-tight", present.tone)}
            >
              {present.title}
            </h2>
            <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
              {present.what}
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <p
            className={cn(
              "max-w-[65ch] text-sm leading-relaxed",
              present.warnOnResume ? present.tone : "text-foreground",
            )}
          >
            {present.fix}
          </p>

          {pendingCount !== null && pendingCount > 0 ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {fill(copy.remaining, {
                count: formatCount(pendingCount, locale),
              })}
            </p>
          ) : null}

          {pauseReason ? (
            <div className="rounded-lg bg-secondary px-3 py-2">
              <p className="eyebrow text-muted-foreground">
                {copy.reasonLabel}
              </p>
              <p className="mt-1 text-sm text-foreground">{pauseReason}</p>
            </div>
          ) : null}

          {present.action ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              render={<Link href={present.action.href} />}
            >
              {present.action.label}
            </Button>
          ) : null}

        </div>
      </div>
    </section>
  );
}
