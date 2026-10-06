"use client";

import { Loader2, RefreshCw } from "lucide-react";
import type { CampaignStats } from "@/lib/api/campaigns";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { fill, formatCount, formatUsd } from "./format";

/**
 * Per-campaign delivery. Every number here is a live aggregate over
 * `campaign_recipients` — there are no denormalised counters that can drift,
 * so a refresh is always the truth and never a "recalculating…" state.
 *
 * Two facts the aggregate carries that a naive funnel would misread, both
 * stated in the UI rather than left to the reader:
 *   - `delivered` counts `read` as well, so read can never exceed delivered;
 *   - `replied` is last-touch over a 7-day window, not multi-touch.
 */
export function CampaignStatsPanel({
  stats,
  refreshing,
  onRefresh,
}: {
  stats: CampaignStats;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const launched = stats.recipientCount > 0 || stats.sent > 0;

  const percent = (value: number): string | null => {
    if (stats.sent === 0) return null;
    return new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(value / stats.sent);
  };

  const SKIP_LABEL: Record<string, string> = {
    opted_out: t.campaigns.stats.skipOptedOut,
    canceled: t.campaigns.stats.skipCanceled,
    no_conversation: t.campaigns.stats.skipNoConversation,
    invalid_phone: t.campaigns.stats.skipInvalidPhone,
  };

  return (
    <section className="space-y-5" aria-labelledby="campaign-stats-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="campaign-stats-title"
          className="font-display text-lg font-medium tracking-tight"
        >
          {t.campaigns.stats.title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          {t.campaigns.stats.refresh}
        </Button>
      </div>

      {!launched ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-8">
          <p className="font-medium text-foreground">
            {t.campaigns.stats.notLaunched}
          </p>
          <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
            {t.campaigns.stats.notLaunchedBody}
          </p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
            <Figure
              label={t.campaigns.stats.recipients}
              value={formatCount(stats.recipientCount, locale)}
            />
            <Figure
              label={t.campaigns.stats.sent}
              value={formatCount(stats.sent, locale)}
              emphasis
            />
            <Figure
              label={t.campaigns.stats.delivered}
              value={formatCount(stats.delivered, locale)}
              hint={percent(stats.delivered)}
            />
            <Figure
              label={t.campaigns.stats.read}
              value={formatCount(stats.read, locale)}
              hint={percent(stats.read)}
            />
            <Figure
              label={t.campaigns.stats.replied}
              value={formatCount(stats.replied, locale)}
              hint={percent(stats.replied)}
            />
          </dl>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border pt-5 sm:grid-cols-4">
            <Figure
              label={t.campaigns.stats.pending}
              value={formatCount(stats.pending, locale)}
            />
            <Figure
              label={t.campaigns.stats.sending}
              value={formatCount(stats.sending, locale)}
            />
            <Figure
              label={t.campaigns.stats.failed}
              value={formatCount(stats.failed, locale)}
              tone={stats.failed > 0 ? "text-destructive" : undefined}
            />
            <Figure
              label={t.campaigns.stats.skipped}
              value={formatCount(stats.skipped, locale)}
            />
          </dl>

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{t.campaigns.stats.deliveredNote}</p>
            <p className="max-w-[65ch]">{t.campaigns.stats.repliedNote}</p>
          </div>

          {Object.keys(stats.skippedByReason).length > 0 ? (
            <div className="space-y-2 border-t border-border pt-5">
              <h3 className="text-sm font-medium text-foreground">
                {t.campaigns.stats.skippedTitle}
              </h3>
              <ul className="space-y-1">
                {Object.entries(stats.skippedByReason).map(([reason, count]) => (
                  <li
                    key={reason}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {SKIP_LABEL[reason] ?? reason}
                    </span>
                    <span className="tabular-nums text-foreground">
                      {formatCount(count, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <div className="border-t border-border pt-5">
        <p className="eyebrow text-muted-foreground">
          {t.campaigns.stats.spend}
        </p>
        <p className="mt-1 font-display text-2xl tabular-nums">
          {fill(t.campaigns.stats.spendOfCap, {
            spent: formatUsd(stats.spentUsd, locale),
            cap: formatUsd(stats.spendCapUsd, locale),
          })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {fill(t.campaigns.stats.estimated, {
            cost: formatUsd(stats.estimatedCostUsd, locale),
          })}
        </p>
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  hint,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  emphasis?: boolean;
  tone?: string;
}) {
  return (
    <div>
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd
        className={[
          "mt-1 font-display tabular-nums",
          emphasis ? "text-3xl" : "text-2xl",
          tone ?? "text-foreground",
        ].join(" ")}
      >
        {value}
        {hint ? (
          <span className="ms-2 align-middle text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
