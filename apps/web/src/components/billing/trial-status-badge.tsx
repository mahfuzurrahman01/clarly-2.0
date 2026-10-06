import { type TenantSubscriptionRecord, trialDaysRemaining } from "@/lib/api/billing";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Days-left / expired indicator for the console shell (shipped under the
 * former launch plan; see docs/GULF_PARITY_PLAN.md). Renders nothing once
 * the tenant has a paid, non-trialing subscription (or none at all) — only
 * relevant during the local, no-card trial window.
 */
export function TrialStatusBadge({
  subscription,
  className,
}: {
  subscription: TenantSubscriptionRecord | null;
  className?: string;
}) {
  const t = useTranslations();
  const daysLeft = trialDaysRemaining(subscription);
  if (daysLeft === null) return null;

  const expired = daysLeft <= 0;
  const label = expired
    ? t.trial.expiredLabel
    : daysLeft === 1
      ? t.trial.lastDayLabel
      : t.trial.daysLeftTemplate.replace("{days}", String(daysLeft));

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs",
        expired
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
        className,
      )}
    >
      {label}
    </span>
  );
}
