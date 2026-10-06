"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  RECIPIENTS_PAGE_SIZE,
  RECIPIENT_STATUSES,
  listCampaignRecipients,
  type CampaignRecipient,
  type RecipientStatus,
} from "@/lib/api/campaigns";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fill, formatDateTime, formatUsd } from "./format";

type Filter = RecipientStatus | "all";

/**
 * The snapshotted recipient list. Every row ends in a terminal state with a
 * reason (D1/D3's invariant), so the skip reason is a first-class column
 * rather than a tooltip — "skipped" with no reason is the failure mode this
 * screen exists to make impossible.
 */
export function CampaignRecipients({
  campaignId,
  launched,
  initial,
}: {
  campaignId: string;
  /** Before launch there is no snapshot at all — the audience is still a live query. */
  launched: boolean;
  /** Page 1, unfiltered, from the server render. */
  initial: CampaignRecipient[];
}) {
  const t = useTranslations();

  // Split rather than branched inside one component: before launch there is
  // no list to page through at all, so the fetching half is simply not
  // mounted instead of being guarded on every render.
  if (!launched) {
    return (
      <section className="space-y-3" aria-labelledby="recipients-title">
        <h2
          id="recipients-title"
          className="font-display text-lg font-medium tracking-tight"
        >
          {t.campaigns.recipients.title}
        </h2>
        <p className="max-w-[65ch] rounded-xl border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">
          {t.campaigns.recipients.emptyBeforeLaunch}
        </p>
      </section>
    );
  }

  return <RecipientsTable campaignId={campaignId} initial={initial} />;
}

function RecipientsTable({
  campaignId,
  initial,
}: {
  campaignId: string;
  initial: CampaignRecipient[];
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [rows, setRows] = useState<CampaignRecipient[]>(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Page 1 came with the server render; the first effect run has nothing to
  // do, and a setState on mount would cascade a second render for nothing.
  const skipFirstFetch = useRef(true);

  useEffect(() => {
    if (skipFirstFetch.current) {
      skipFirstFetch.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    listCampaignRecipients(campaignId, {
      limit: RECIPIENTS_PAGE_SIZE,
      offset,
      status: filter === "all" ? undefined : filter,
    })
      .then((result) => {
        if (cancelled) return;
        setRows(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(apiErrorMessage(err, t, t.campaigns.recipients.couldNotLoad));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is stable for the session (server-resolved dictionary).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, filter, offset]);

  const STATUS_LABEL: Record<Filter, string> = {
    all: t.campaigns.recipients.filterAll,
    pending: t.campaigns.recipients.statusPending,
    sending: t.campaigns.recipients.statusSending,
    sent: t.campaigns.recipients.statusSent,
    failed: t.campaigns.recipients.statusFailed,
    skipped: t.campaigns.recipients.statusSkipped,
  };

  const SKIP_LABEL: Record<string, string> = {
    opted_out: t.campaigns.stats.skipOptedOut,
    canceled: t.campaigns.stats.skipCanceled,
    no_conversation: t.campaigns.stats.skipNoConversation,
    invalid_phone: t.campaigns.stats.skipInvalidPhone,
  };

  return (
    <section className="space-y-4" aria-labelledby="recipients-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2
            id="recipients-title"
            className="font-display text-lg font-medium tracking-tight"
          >
            {t.campaigns.recipients.title}
          </h2>
          <p className="max-w-[65ch] text-sm text-muted-foreground">
            {t.campaigns.recipients.subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="recipient-filter" className="text-xs">
            {t.campaigns.recipients.columnStatus}
          </Label>
          <Select
            value={filter}
            onValueChange={(next) => {
              setFilter(next as Filter);
              setOffset(0);
            }}
          >
            <SelectTrigger id="recipient-filter" className="w-40">
              <SelectValue>{() => STATUS_LABEL[filter]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{STATUS_LABEL.all}</SelectItem>
              {RECIPIENT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {STATUS_LABEL[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {rows.length === 0 && !loading ? (
        <p className="rounded-xl border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">
          {t.campaigns.recipients.empty}
        </p>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th scope="col" className="px-4 py-2 text-start text-xs font-medium text-muted-foreground">
                  {t.campaigns.recipients.columnCustomer}
                </th>
                <th scope="col" className="px-4 py-2 text-start text-xs font-medium text-muted-foreground">
                  {t.campaigns.recipients.columnStatus}
                </th>
                <th scope="col" className="hidden px-4 py-2 text-start text-xs font-medium text-muted-foreground sm:table-cell">
                  {t.campaigns.recipients.columnDelivery}
                </th>
                <th scope="col" className="hidden px-4 py-2 text-start text-xs font-medium text-muted-foreground md:table-cell">
                  {t.campaigns.recipients.columnCost}
                </th>
                <th scope="col" className="hidden px-4 py-2 text-start text-xs font-medium text-muted-foreground lg:table-cell">
                  {t.campaigns.recipients.columnSent}
                </th>
              </tr>
            </thead>
            <tbody className={loading ? "opacity-60 transition-opacity" : undefined}>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 font-medium tabular-nums text-foreground">
                    <bdi>{row.phone}</bdi>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        row.status === "failed"
                          ? "text-destructive"
                          : "text-foreground"
                      }
                    >
                      {STATUS_LABEL[row.status] ?? row.status}
                    </span>
                    {row.skipReason ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {SKIP_LABEL[row.skipReason] ?? row.skipReason}
                      </span>
                    ) : null}
                    {row.deliveryError ? (
                      <span className="mt-0.5 block max-w-[40ch] text-xs text-destructive">
                        {row.deliveryError}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                    {row.repliedAt
                      ? t.campaigns.recipients.deliveryReplied
                      : row.readAt
                        ? t.campaigns.recipients.deliveryRead
                        : row.deliveredAt
                          ? t.campaigns.recipients.deliveryDelivered
                          : t.campaigns.recipients.deliveryNone}
                    {row.attemptCount > 1 ? (
                      <span className="mt-0.5 block text-xs tabular-nums">
                        {fill(t.campaigns.recipients.attempts, {
                          count: new Intl.NumberFormat(locale).format(
                            row.attemptCount,
                          ),
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden px-4 py-3 tabular-nums text-muted-foreground md:table-cell">
                    {row.costUsd === null ? "—" : formatUsd(row.costUsd, locale)}
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                    {formatDateTime(row.sentAt, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - RECIPIENTS_PAGE_SIZE))}
          >
            {t.campaigns.recipients.previous}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length < RECIPIENTS_PAGE_SIZE || loading}
            onClick={() => setOffset(offset + RECIPIENTS_PAGE_SIZE)}
          >
            {t.campaigns.recipients.next}
          </Button>
        </div>
      </div>
    </section>
  );
}
