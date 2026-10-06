"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import {
  COURIER_CAPABILITIES,
  isTerminalStatus,
  lastWebhookEvent,
  type ShipmentRow,
} from "@/lib/api/delivery";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { LtrToken } from "./ltr-token";
import { ShipmentStatusBadge } from "./shipment-status-badge";
import { ShipmentTimeline } from "./shipment-timeline";
import {
  courierLabel,
  formatDateTime,
  formatDateTimeOr,
  orderStatusLabel,
  shipmentStatusLabel,
} from "./format";

function Fact({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-[0.6875rem] tracking-wide text-muted-foreground uppercase">
        {term}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * One shipment in the list, with its tracking history folded away underneath.
 *
 * The detail opens with a `grid-template-rows: 0fr → 1fr` transition rather
 * than an animated height: it is the one way to animate "as tall as the
 * content is" without measuring, and it keeps the animation on a property
 * that does not force a layout pass on every frame.
 */
export function ShipmentListRow({
  row,
  expanded,
  onToggle,
}: {
  row: ShipmentRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { shipment, order } = row;
  const detailId = `shipment-detail-${shipment.id}`;

  const supportsWebhook = COURIER_CAPABILITIES[shipment.courier].supportsWebhook;
  const webhookEvent = lastWebhookEvent(shipment);
  const terminal = isTerminalStatus(shipment.currentStatus);

  return (
    <li className="group/row">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 transition-colors hover:bg-secondary/40">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <LtrToken className="text-sm font-medium" tabular>
                {shipment.trackingNumber}
              </LtrToken>
              <LtrToken className="text-xs text-muted-foreground">
                {courierLabel(shipment.courier)}
              </LtrToken>
            </span>
            <span className="block text-xs text-muted-foreground">
              {expanded ? t.delivery.list.collapse : t.delivery.list.expand}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 flex-col items-start gap-1">
          <ShipmentStatusBadge status={shipment.currentStatus} />
          <span className="text-xs text-muted-foreground">
            {formatDateTimeOr(
              shipment.currentStatusAt,
              locale,
              t.delivery.detail.neverPolled,
            )}
          </span>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-1">
          <Link
            href={`/orders/${order.id}`}
            className="inline-flex items-center gap-1 rounded-md text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <LtrToken tabular>{order.reference}</LtrToken>
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{t.delivery.list.openOrder}</span>
          </Link>
          <span className="text-xs text-muted-foreground">
            {orderStatusLabel(t, order.status)}
          </span>
        </div>
      </div>

      <div
        id={detailId}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-6 border-t border-border bg-secondary/30 px-4 py-6 sm:px-6">
            <section className="space-y-3">
              <h4 className="text-sm font-medium">
                {t.delivery.detail.freshnessTitle}
              </h4>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Fact term={t.delivery.detail.lastPolled}>
                  {formatDateTimeOr(
                    shipment.lastPolledAt,
                    locale,
                    t.delivery.detail.neverPolled,
                  )}
                </Fact>
                {supportsWebhook ? (
                  <Fact term={t.delivery.detail.lastWebhook}>
                    {webhookEvent
                      ? `${formatDateTime(webhookEvent.occurredAt, locale)} · ${shipmentStatusLabel(t, webhookEvent.status)}`
                      : t.delivery.detail.noWebhook}
                  </Fact>
                ) : null}
                <Fact term={t.delivery.detail.pollFailures}>
                  {shipment.pollFailureCount > 0
                    ? shipment.pollFailureCount
                    : t.delivery.detail.pollFailuresHealthy}
                </Fact>
                <Fact term={t.delivery.detail.etaLabel}>
                  {formatDateTimeOr(
                    shipment.estimatedDeliveryAt,
                    locale,
                    t.delivery.detail.etaUnknown,
                  )}
                </Fact>
                {shipment.deliveredAt ? (
                  <Fact term={t.delivery.detail.deliveredLabel}>
                    {formatDateTime(shipment.deliveredAt, locale)}
                  </Fact>
                ) : null}
                <Fact term={t.delivery.detail.notifiedLabel}>
                  {shipment.lastNotifiedStatus && shipment.lastNotifiedAt
                    ? `${shipmentStatusLabel(t, shipment.lastNotifiedStatus)} · ${formatDateTime(shipment.lastNotifiedAt, locale)}`
                    : t.delivery.detail.notifiedNever}
                </Fact>
              </dl>
              <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
                {supportsWebhook
                  ? t.delivery.detail.webhookNote
                  : t.delivery.detail.pollOnlyNote}
                {terminal ? ` ${t.delivery.detail.terminalNote}` : ""}
              </p>
            </section>

            <section className="space-y-4">
              <h4 className="text-sm font-medium">
                {t.delivery.detail.timelineTitle}
              </h4>
              <ShipmentTimeline shipment={shipment} />
            </section>
          </div>
        </div>
      </div>
    </li>
  );
}
