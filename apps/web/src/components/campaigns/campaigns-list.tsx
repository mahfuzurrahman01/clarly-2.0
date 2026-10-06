"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Megaphone, Plus, Users } from "lucide-react";
import {
  CAMPAIGNS_PAGE_SIZE,
  listCampaigns,
  type CampaignListResult,
  type CampaignRecord,
} from "@/lib/api/campaigns";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { CampaignStatusChip } from "./campaign-status-chip";
import { fill, formatCount, formatDateTime, formatUsd } from "./format";

/**
 * The campaign list. Page 1 arrives from the server; paging goes through the
 * browser client.
 *
 * `GET /campaigns` returns no collection count — only the rows on this page —
 * so paging is expressed as prev/next on a full page rather than as "page 3
 * of 12", which the console has no honest way to know.
 */
export function CampaignsList({ initial }: { initial: CampaignListResult }) {
  const t = useTranslations();
  const locale = useLocale();

  const [campaigns, setCampaigns] = useState(initial.campaigns);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Page 1 is already on screen from the server render — the first effect
  // run has nothing to fetch, and calling setState on mount would cascade.
  const skipFirstFetch = useRef(true);

  useEffect(() => {
    if (skipFirstFetch.current) {
      skipFirstFetch.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    listCampaigns({ limit: CAMPAIGNS_PAGE_SIZE, offset })
      .then((result) => {
        if (cancelled) return;
        setCampaigns(result.campaigns);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(apiErrorMessage(err, t, t.campaigns.list.couldNotLoad));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is stable for the session (server-resolved dictionary).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  if (campaigns.length === 0 && offset === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50 text-start">
              <Th>{t.campaigns.list.columnCampaign}</Th>
              <Th>{t.campaigns.list.columnStatus}</Th>
              <Th className="hidden sm:table-cell">
                {t.campaigns.list.columnAudience}
              </Th>
              <Th className="hidden md:table-cell">
                {t.campaigns.list.columnSpend}
              </Th>
              <Th className="hidden lg:table-cell">
                {t.campaigns.list.columnUpdated}
              </Th>
            </tr>
          </thead>
          <tbody className={loading ? "opacity-60 transition-opacity" : undefined}>
            {campaigns.map((campaign) => (
              <Row key={campaign.id} campaign={campaign} locale={locale} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - CAMPAIGNS_PAGE_SIZE))}
          >
            {t.campaigns.list.previous}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={campaigns.length < CAMPAIGNS_PAGE_SIZE || loading}
            onClick={() => setOffset(offset + CAMPAIGNS_PAGE_SIZE)}
          >
            {t.campaigns.list.next}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({
  campaign,
  locale,
}: {
  campaign: CampaignRecord;
  locale: ReturnType<typeof useLocale>;
}) {
  const t = useTranslations();
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-secondary/40">
      <td className="px-4 py-3">
        <Link
          href={`/campaigns/${campaign.id}`}
          className="font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {campaign.name}
        </Link>
        <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
          {campaign.recipientCount > 0
            ? fill(t.campaigns.list.recipients, {
                count: formatCount(campaign.recipientCount, locale),
              })
            : t.campaigns.list.notLaunched}
        </span>
      </td>
      <td className="px-4 py-3">
        <CampaignStatusChip status={campaign.status} />
      </td>
      <td className="hidden px-4 py-3 tabular-nums text-muted-foreground sm:table-cell">
        {campaign.recipientCount > 0
          ? fill(t.campaigns.list.recipients, {
              count: formatCount(campaign.recipientCount, locale),
            })
          : t.campaigns.list.notLaunched}
      </td>
      <td className="hidden px-4 py-3 tabular-nums text-muted-foreground md:table-cell">
        {formatUsd(campaign.spentUsd, locale)}{" "}
        <span className="text-xs">
          {fill(t.campaigns.list.ofCap, {
            cap: formatUsd(campaign.spendCapUsd, locale),
          })}
        </span>
      </td>
      <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
        {formatDateTime(campaign.updatedAt, locale)}
      </td>
    </tr>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-2 text-start text-xs font-medium text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function EmptyState() {
  const t = useTranslations();
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-14">
      <div className="mx-auto max-w-[52ch] space-y-3 text-center">
        <Megaphone className="mx-auto size-5 text-muted-foreground" aria-hidden />
        <h2 className="font-display text-xl tracking-tight">
          {t.campaigns.list.emptyTitle}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t.campaigns.list.emptyBody}
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Button render={<Link href="/campaigns/audiences" />}>
            <Users data-icon="inline-start" />
            {t.campaigns.list.emptyAction}
          </Button>
          <Button variant="outline" render={<Link href="/campaigns/new" />}>
            <Plus data-icon="inline-start" />
            {t.campaigns.list.newCampaign}
          </Button>
        </div>
      </div>
    </div>
  );
}
