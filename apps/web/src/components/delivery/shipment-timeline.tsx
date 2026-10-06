"use client";

import { Info } from "lucide-react";
import {
  progressRank,
  type Shipment,
  type ShipmentStatusEvent,
} from "@/lib/api/delivery";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { LtrToken } from "./ltr-token";
import { formatDateTime, shipmentStatusLabel, sourceLabel } from "./format";

type TimelineEntry = ShipmentStatusEvent & {
  /** False when the courier replayed an event at or below the high-water mark. */
  advanced: boolean;
};

/**
 * Oldest first, with the backend's monotonic rule made visible.
 *
 * The API records every event a courier reports, including replays of older
 * ones, but the shipment's status only ever moves forward. Sorting ascending
 * and marking the replays is what makes that legible: the rail reads as one
 * forward progression, and an event that arrived late is shown sitting at its
 * own time without pretending the parcel went backwards.
 *
 * Statuses outside the progress spine (`failed_attempt`, `exception`, …) have
 * no rank, so they are always drawn as real entries — a failed attempt is
 * news, not a regression.
 */
function toEntries(history: ShipmentStatusEvent[]): TimelineEntry[] {
  const ordered = [...history].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  );
  let highWater = -1;
  return ordered.map((event) => {
    const rank = progressRank(event.status);
    if (rank < 0) return { ...event, advanced: true };
    const advanced = rank > highWater;
    if (advanced) highWater = rank;
    return { ...event, advanced };
  });
}

export function ShipmentTimeline({ shipment }: { shipment: Shipment }) {
  const t = useTranslations();
  const locale = useLocale();
  const entries = toEntries(shipment.history);

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t.delivery.detail.timelineEmpty}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {t.delivery.detail.monotonicNote}
      </p>
      <ol className="space-y-0">
        {entries.map((entry, index) => {
          const isLast = index === entries.length - 1;
          const isCurrent = isLast && entry.status === shipment.currentStatus;
          return (
            <li
              key={`${entry.rawStatus}-${entry.occurredAt}`}
              className="grid grid-cols-[auto_1fr] gap-x-4"
            >
              <div
                className="flex flex-col items-center pt-1.5"
                aria-hidden="true"
              >
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full border",
                    entry.advanced
                      ? "border-lime-ring bg-lime-ring"
                      : "border-border bg-card",
                  )}
                />
                {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
              </div>

              <div className={cn("min-w-0", isLast ? "pb-0" : "pb-6")}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={cn(
                      "text-sm",
                      entry.advanced
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {shipmentStatusLabel(t, entry.status)}
                  </span>
                  {isCurrent ? (
                    <span className="rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-[0.6875rem] text-lime-text">
                      {t.delivery.detail.current}
                    </span>
                  ) : null}
                  {!entry.advanced ? (
                    <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
                      {t.delivery.detail.notAdvanced}
                    </span>
                  ) : null}
                </div>

                <p className="mt-1 text-xs text-muted-foreground">
                  <time dateTime={entry.occurredAt}>
                    {formatDateTime(entry.occurredAt, locale)}
                  </time>
                  {entry.location ? (
                    <>
                      <span className="mx-1.5" aria-hidden>
                        ·
                      </span>
                      {entry.location}
                    </>
                  ) : null}
                </p>

                <p className="mt-2 flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted-foreground">
                  <span className="rounded-md border border-border bg-secondary px-1.5 py-0.5">
                    {sourceLabel(t, entry.source)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span>{t.delivery.detail.rawStatusLabel}</span>
                    <LtrToken className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono">
                      {entry.rawStatus}
                    </LtrToken>
                  </span>
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
