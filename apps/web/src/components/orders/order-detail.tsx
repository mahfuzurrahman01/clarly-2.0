"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, Loader2, MessageSquare } from "lucide-react";
import type { OrderItemView, OrderView } from "@/lib/api/orders";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  NotNotifiedBadge,
  OrderStatusBadge,
  StoreSyncBadge,
} from "./order-badges";
import type { OrderShipmentsData } from "@/lib/api/delivery";
import { OrderShipments } from "@/components/delivery/order-shipments";
import { RejectOrderDialog } from "./reject-order-dialog";
import { useOrderActions } from "./use-order-actions";
import { fill, formatDateTime, formatMoney } from "./format";

/**
 * One order, in full: what was bought at what price, where it's going, what
 * has happened to it, and the two links back to the people involved.
 *
 * There is no status-history endpoint — the API exposes the order's own
 * timestamps and the audit log is not fronted for orders — so "what happened"
 * is derived from `createdAt` / `approvedAt` / `customerNotifiedAt` /
 * `updatedAt` plus the terminal status. That is stated on the page rather
 * than implied, so nobody reads it as a complete audit trail.
 */
export function OrderDetail({
  initialOrder,
  items,
  shipments,
}: {
  initialOrder: OrderView;
  items: OrderItemView[];
  /** `null` when the server-side read failed; the card offers a retry. */
  shipments: OrderShipmentsData | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [order, setOrder] = useState(initialOrder);
  const [rejecting, setRejecting] = useState<OrderView | null>(null);

  const onUpdated = useCallback((updated: OrderView) => setOrder(updated), []);
  const { approve, reject, cancel, retry, pending } = useOrderActions(onUpdated);

  const busy = pending?.id === order.id;
  const Back = locale === "ar" ? ArrowRight : ArrowLeft;
  const notNotified =
    order.customerNotifiedAt === null &&
    (order.status === "confirmed" ||
      order.status === "rejected" ||
      order.status === "cancelled");

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <Link
        href="/orders"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline"
      >
        <Back className="size-4" aria-hidden="true" />
        {t.orders.detail.back}
      </Link>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div className="space-y-2">
          <p className="eyebrow text-lime-text">{t.orders.detail.eyebrow}</p>
          <h1 className="font-display text-3xl font-medium tracking-tight tabular-nums">
            {order.reference}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.status} />
            <StoreSyncBadge status={order.storeSyncStatus} />
            {notNotified ? <NotNotifiedBadge /> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {fill(t.orders.detail.placedTemplate, {
              date: formatDateTime(order.createdAt, locale),
            })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {order.status === "pending_approval" ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRejecting(order)}
              >
                {t.orders.queue.reject}
              </Button>
              <Button disabled={busy} onClick={() => approve(order)}>
                {busy && pending?.action === "approve" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {t.orders.queue.approve}
              </Button>
            </>
          ) : null}
          {order.status === "confirmed" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => cancel(order)}
            >
              {busy && pending?.action === "cancel" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t.orders.actions.cancelOrder}
            </Button>
          ) : null}
        </div>
      </div>

      {notNotified ? (
        <p className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {t.orders.list.notNotifiedHint}
        </p>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          <Items order={order} items={items} />
          <Timeline order={order} />
        </div>

        <div className="space-y-8">
          <Delivery order={order} />
          <OrderShipments
            orderId={order.id}
            orderReference={order.reference}
            orderStatus={order.status}
            initialData={shipments}
          />
          <Payment order={order} />
          <StorePush
            order={order}
            busy={busy && pending?.action === "retry"}
            onRetry={() => retry(order)}
          />
          <Origin order={order} />
        </div>
      </div>

      <RejectOrderDialog
        order={rejecting}
        submitting={pending?.action === "reject"}
        onOpenChange={(open) => (open ? null : setRejecting(null))}
        onConfirm={(target, reason) => reject(target, reason)}
      />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display text-lg font-medium tracking-tight">
      {children}
    </h2>
  );
}

function Items({ order, items }: { order: OrderView; items: OrderItemView[] }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <section className="space-y-3">
      <SectionTitle>{t.orders.detail.itemsTitle}</SectionTitle>
      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[30rem] text-sm">
          <caption className="sr-only">{t.orders.detail.itemsTitle}</caption>
          <thead className="bg-secondary/60 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                {t.orders.detail.colItem}
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2 text-start font-medium sm:table-cell"
              >
                {t.orders.detail.colSku}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                {t.orders.detail.colUnitPrice}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                {t.orders.detail.colQuantity}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                {t.orders.detail.colLineTotal}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="px-4 py-3">{item.productName}</td>
                <td className="hidden px-4 py-3 text-xs text-muted-foreground sm:table-cell">
                  {item.sku ?? "—"}
                </td>
                <td className="px-4 py-3 text-end tabular-nums">
                  {formatMoney(item.unitPrice, item.currency, locale)}
                </td>
                <td className="px-4 py-3 text-end tabular-nums">
                  {item.quantity}
                </td>
                <td className="px-4 py-3 text-end tabular-nums">
                  {formatMoney(item.lineTotal, item.currency, locale)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border">
            <tr>
              <td className="px-4 py-2 text-xs text-muted-foreground" colSpan={4}>
                {t.orders.detail.subtotal}
              </td>
              <td className="px-4 py-2 text-end text-sm tabular-nums">
                {formatMoney(order.subtotal, order.currency, locale)}
              </td>
            </tr>
            <tr>
              <td className="px-4 pb-3 font-medium" colSpan={4}>
                {t.orders.detail.total}
              </td>
              <td className="px-4 pb-3 text-end font-medium tabular-nums">
                {formatMoney(order.total, order.currency, locale)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t.orders.detail.priceSnapshotNote} {t.orders.detail.totalsNote}
      </p>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function Delivery({ order }: { order: OrderView }) {
  const t = useTranslations();
  return (
    <section className="space-y-3">
      <SectionTitle>{t.orders.detail.deliveryTitle}</SectionTitle>
      <dl className="space-y-3 rounded-xl border border-border p-4">
        <Field label={t.orders.detail.contactName} value={order.contactName} />
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">
            {t.orders.detail.contactPhone}
          </dt>
          <dd className="text-sm tabular-nums" dir="ltr">
            {order.contactPhone}
          </dd>
        </div>
        <Field
          label={t.orders.detail.city}
          value={order.city ?? t.orders.detail.notGiven}
        />
        <Field label={t.orders.detail.address} value={order.address} />
        <Field
          label={t.orders.detail.notes}
          value={order.notes ?? t.orders.detail.notGiven}
        />
      </dl>
    </section>
  );
}

function Payment({ order }: { order: OrderView }) {
  const t = useTranslations();
  return (
    <section className="space-y-3">
      <SectionTitle>{t.orders.detail.paymentTitle}</SectionTitle>
      <dl className="space-y-3 rounded-xl border border-border p-4">
        <Field
          label={t.orders.detail.paymentMethod}
          value={
            order.paymentMethod === "cod"
              ? t.orders.detail.paymentCod
              : order.paymentMethod
          }
        />
        <Field
          label={t.orders.detail.paymentStatus}
          value={
            order.paymentStatus === "collected"
              ? t.orders.detail.paymentCollected
              : t.orders.detail.paymentUnpaid
          }
        />
      </dl>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t.orders.detail.paymentNote}
      </p>
    </section>
  );
}

/**
 * The store push is shown even when it succeeded, because "is this in my
 * store yet" is the second question a merchant asks after "is it confirmed".
 */
function StorePush({
  order,
  busy,
  onRetry,
}: {
  order: OrderView;
  busy: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations();
  return (
    <section className="space-y-3">
      <SectionTitle>{t.orders.detail.storeTitle}</SectionTitle>
      <div className="space-y-3 rounded-xl border border-border p-4">
        <StoreSyncBadge status={order.storeSyncStatus} />
        {order.storeSyncStatus === "not_applicable" ? (
          <p className="text-sm text-muted-foreground">
            {t.orders.detail.storeNone}
          </p>
        ) : null}
        {order.externalOrderId ? (
          <p className="text-sm tabular-nums">
            {fill(t.orders.detail.storeExternalIdTemplate, {
              id: order.externalOrderId,
            })}
          </p>
        ) : null}
        {order.storeSyncStatus === "failed" ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t.orders.detail.storeFailedBody}
            </p>
            {order.storeSyncError ? (
              <p className="text-xs text-destructive">
                {t.orders.detail.storeErrorLabel}: {order.storeSyncError}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground tabular-nums">
              {fill(t.orders.detail.storeAttemptsTemplate, {
                count: order.storeSyncAttempts,
              })}
            </p>
            <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.orders.actions.retryStorePush}
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function Origin({ order }: { order: OrderView }) {
  const t = useTranslations();
  return (
    <section className="space-y-3">
      <SectionTitle>{t.orders.detail.linksTitle}</SectionTitle>
      <div className="space-y-3 rounded-xl border border-border p-4">
        {order.conversationId ? (
          <Link
            href={`/inbox/${order.conversationId}`}
            className="inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline focus-visible:underline"
          >
            <MessageSquare className="size-4" aria-hidden="true" />
            {t.orders.detail.openConversation}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t.orders.detail.noConversation}
          </p>
        )}
        <div className="space-y-1">
          <Link
            href={`/orders?customerId=${order.customerId}`}
            className="text-sm underline-offset-4 hover:underline focus-visible:underline"
          >
            {t.orders.detail.filterByCustomer}
          </Link>
          <p className="text-xs text-muted-foreground">
            {t.orders.detail.customerIdNote}
          </p>
        </div>
      </div>
    </section>
  );
}

type TimelineEntry = { at: string; label: string; detail?: string };

/** Derived from the order's own timestamps — see the note on {@link OrderDetail}. */
function buildTimeline(
  order: OrderView,
  t: ReturnType<typeof useTranslations>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { at: order.createdAt, label: t.orders.detail.timelinePlaced },
  ];

  if (order.approvedAt) {
    entries.push({
      at: order.approvedAt,
      label:
        order.status === "rejected"
          ? t.orders.detail.timelineRejected
          : t.orders.detail.timelineApproved,
      detail: order.approvedBy
        ? fill(t.orders.detail.timelineApprovedByTemplate, {
            user: order.approvedBy,
          })
        : undefined,
    });
  }

  if (order.rejectedReason) {
    entries.push({
      at: order.updatedAt,
      label: t.orders.detail.timelineRejected,
      detail: fill(t.orders.detail.timelineRejectionReasonTemplate, {
        reason: order.rejectedReason,
      }),
    });
  }

  if (order.customerNotifiedAt) {
    entries.push({
      at: order.customerNotifiedAt,
      label: t.orders.detail.timelineNotified,
    });
  }

  const terminal: Partial<Record<OrderView["status"], string>> = {
    cancelled: t.orders.detail.timelineCancelled,
    expired: t.orders.detail.timelineExpired,
    fulfilled: t.orders.detail.timelineFulfilled,
    failed: t.orders.detail.timelineFailed,
  };
  const terminalLabel = terminal[order.status];
  if (terminalLabel) {
    entries.push({ at: order.updatedAt, label: terminalLabel });
  }

  return entries.sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
}

function Timeline({ order }: { order: OrderView }) {
  const t = useTranslations();
  const locale = useLocale();
  const entries = buildTimeline(order, t);

  return (
    <section className="space-y-3">
      <SectionTitle>{t.orders.detail.timelineTitle}</SectionTitle>
      <ol className="space-y-4 rounded-xl border border-border p-4">
        {entries.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="flex gap-3">
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-lime-ring"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              <p className="text-sm">{entry.label}</p>
              {entry.detail ? (
                <p className="text-sm text-muted-foreground">{entry.detail}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {formatDateTime(entry.at, locale)}
              </p>
            </div>
          </li>
        ))}
        {order.customerNotifiedAt === null &&
        order.status !== "pending_approval" ? (
          <li className="flex gap-3">
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {t.orders.detail.timelineNotNotified}
            </p>
          </li>
        ) : null}
      </ol>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t.orders.detail.timelineNote}
      </p>
    </section>
  );
}
