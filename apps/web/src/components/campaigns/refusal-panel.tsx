"use client";

import { AlertTriangle, ShieldAlert, Wallet, X } from "lucide-react";
import type { CampaignRefusal } from "@/lib/api/campaigns";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { formatUsd } from "./format";

/**
 * The three ways `schedule`/`resume` say no (D2's template gate, D3's
 * pre-flight spend cap, D4's eligibility gate) plus the 409 for a verb that
 * does not apply to the current status.
 *
 * Each is rendered as what it is. The eligibility list is shown in full —
 * the API deliberately returns every block rather than the first, so the
 * merchant fixes everything in one trip.
 */
export function RefusalPanel({
  refusal,
  onDismiss,
}: {
  refusal: CampaignRefusal;
  onDismiss: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const copy = t.campaigns.refusal;

  const eligibilityLabel = (reason: string): string =>
    ({
      number_not_found: t.campaigns.eligibility.numberNotFound,
      number_not_active: t.campaigns.eligibility.numberNotActive,
      messaging_restricted: t.campaigns.eligibility.messagingRestricted,
      quality_red: t.campaigns.eligibility.qualityRed,
      no_payment_method: t.campaigns.eligibility.noPaymentMethod,
      tier_unknown: t.campaigns.eligibility.tierUnknown,
      over_tier_span: t.campaigns.eligibility.overTierSpan,
      business_not_verified: t.campaigns.eligibility.businessNotVerified,
      verification_unknown: t.campaigns.eligibility.verificationUnknown,
      billing_blocked: t.campaigns.eligibility.billingBlocked,
      template_waba_mismatch: t.campaigns.eligibility.templateWabaMismatch,
      // An unrecognised reason still renders its own `message` below — the
      // heading degrades to a generic one rather than the screen breaking.
    })[reason] ?? t.campaigns.eligibility.unknown;

  const heading =
    refusal.kind === "template"
      ? copy.templateTitle
      : refusal.kind === "spend_cap"
        ? copy.spendCapTitle
        : refusal.kind === "eligibility"
          ? copy.eligibilityTitle
          : refusal.kind === "state"
            ? copy.stateTitle
            : copy.title;

  const Icon =
    refusal.kind === "spend_cap"
      ? Wallet
      : refusal.kind === "eligibility"
        ? ShieldAlert
        : AlertTriangle;

  return (
    <section
      role="alert"
      className="rounded-xl border border-destructive/30 bg-destructive/5 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-1.5">
            <h3 className="font-display text-base font-medium tracking-tight text-destructive">
              {heading}
            </h3>
            <p className="max-w-[65ch] text-sm leading-relaxed text-foreground">
              {refusal.message}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label={copy.dismiss}
        >
          <X />
        </Button>
      </div>

      {refusal.kind === "spend_cap" ? (
        <dl className="mt-4 grid gap-3 border-t border-destructive/20 pt-4 sm:grid-cols-3">
          <Figure
            label={copy.spendCapEstimate}
            value={formatUsd(refusal.estimatedCostUsd, locale)}
          />
          <Figure
            label={copy.spendCapCurrent}
            value={formatUsd(refusal.spendCapUsd, locale)}
          />
          <Figure
            label={copy.spendCapRequired}
            value={formatUsd(refusal.requiredCapUsd, locale)}
            emphasis
          />
        </dl>
      ) : null}

      {refusal.kind === "eligibility" && refusal.blocks.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-destructive/20 pt-4">
          {refusal.blocks.map((block) => (
            <li key={block.reason} className="flex gap-3 text-sm">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
              <span>
                <span className="font-medium text-foreground">
                  {eligibilityLabel(block.reason)}
                </span>
                <span className="mt-0.5 block max-w-[65ch] text-muted-foreground">
                  {block.message}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {refusal.kind !== "state" && refusal.kind !== "other" ? (
        <p className="mt-4 max-w-[65ch] text-sm text-muted-foreground">
          {refusal.kind === "template"
            ? copy.templateFix
            : refusal.kind === "spend_cap"
              ? copy.spendCapFix
              : copy.eligibilityFix}
        </p>
      ) : null}
    </section>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd
        className={
          emphasis
            ? "mt-1 font-display text-xl tabular-nums text-destructive"
            : "mt-1 font-display text-xl tabular-nums text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}
