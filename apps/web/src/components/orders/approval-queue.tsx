"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import {
  ORDERS_PAGE_SIZE,
  listOrders,
  type OrderMode,
  type OrderPage,
  type OrderView,
} from "@/lib/api/orders";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { OrdersEmptyState } from "./orders-list";
import { RejectOrderDialog } from "./reject-order-dialog";
import { useOrderActions } from "./use-order-actions";
import { fill, formatMoney, hoursUntilExpiry } from "./format";
import { relativeAgo } from "@/lib/i18n/relative-time";

/**
 * The human-approval surface: every `pending_approval` order, and the two
 * buttons that decide it.
 *
 * A decided order leaves the queue immediately — it is no longer waiting on
 * anybody — and is still reachable under All orders. Two people working the
 * same queue is the normal case, so `useOrderActions` treats the resulting
 * 409 as "already handled", not as a failure (see the note there).
 */
export function ApprovalQueue({
  initial,
  mode,
  approvalWindowHours,
  now,
  onCountChange,
}: {
  initial: OrderPage;
  /** `null` when the signed-in user can't read `/orders/settings` (agent role). */
  mode: OrderMode | null;
  approvalWindowHours: number | null;
  /** Server render time, so the first paint doesn't hydrate to a different age. */
  now: number;
  /** Keeps the tab's count badge honest as orders are decided or paged in. */
  onCountChange?: (count: number, hasMore: boolean) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [orders, setOrders] = useState(initial.orders);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<OrderView | null>(null);

  const onUpdated = useCallback((updated: OrderView) => {
    setOrders((prev) =>
      updated.status === "pending_approval"
        ? prev.map((order) => (order.id === updated.id ? updated : order))
        : prev.filter((order) => order.id !== updated.id),
    );
  }, []);

  const { approve, reject, pending } = useOrderActions(onUpdated);

  useEffect(() => {
    onCountChange?.(orders.length, nextCursor !== null);
  }, [orders.length, nextCursor, onCountChange]);

  async function reload() {
    setLoading(true);
    try {
      const page = await listOrders({
        status: "pending_approval",
        limit: ORDERS_PAGE_SIZE,
      });
      setOrders(page.orders);
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, t, t.orders.list.couldNotLoad));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const page = await listOrders({
        status: "pending_approval",
        cursor: nextCursor,
        limit: ORDERS_PAGE_SIZE,
      });
      setOrders((prev) => [...prev, ...page.orders]);
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, t, t.orders.list.couldNotLoad));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose space-y-1">
          <h2 className="font-display text-lg font-medium tracking-tight">
            {t.orders.queue.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t.orders.queue.description}
          </p>
          {approvalWindowHours !== null ? (
            <p className="text-xs text-muted-foreground">
              {fill(t.orders.queue.windowTemplate, {
                hours: approvalWindowHours,
              })}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {t.orders.queue.refresh}
        </Button>
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {loadError}
        </p>
      ) : null}

      {orders.length === 0 ? (
        <QueueEmpty mode={mode} />
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => {
            const busy = pending?.id === order.id;
            const hoursLeft =
              approvalWindowHours === null
                ? null
                : hoursUntilExpiry(order.createdAt, approvalWindowHours, now);
            return (
              <li
                key={order.id}
                className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-border p-4"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/orders/${order.id}`}
                      className="font-medium tabular-nums underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {order.reference}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {fill(t.orders.queue.placedTemplate, {
                        age: relativeAgo(order.createdAt, locale, now),
                      })}
                    </span>
                    {hoursLeft !== null ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        {hoursLeft < 1
                          ? t.orders.queue.expiresSoon
                          : fill(t.orders.queue.expiresTemplate, {
                              hours: hoursLeft,
                            })}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm">
                    {order.contactName}
                    <span className="text-muted-foreground">
                      {" · "}
                      <span dir="ltr" className="tabular-nums">
                        {order.contactPhone}
                      </span>
                      {order.city ? ` · ${order.city}` : ""}
                    </span>
                  </p>
                  <p className="text-sm font-medium tabular-nums">
                    {formatMoney(order.total, order.currency, locale)}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <Link
                      href={`/orders/${order.id}`}
                      className="underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {t.orders.queue.viewDetail}
                    </Link>
                    {order.conversationId ? (
                      <Link
                        href={`/inbox/${order.conversationId}`}
                        className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline"
                      >
                        <MessageSquare className="size-3.5" aria-hidden="true" />
                        {t.orders.list.openChat}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {t.orders.list.noChat}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRejecting(order)}
                  >
                    {t.orders.queue.reject}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => approve(order)}
                  >
                    {busy && pending?.action === "approve" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    {t.orders.queue.approve}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor ? (
        <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
          {t.orders.queue.loadMore}
        </Button>
      ) : null}

      <RejectOrderDialog
        order={rejecting}
        submitting={pending?.action === "reject"}
        onOpenChange={(open) => (open ? null : setRejecting(null))}
        onConfirm={(order, reason) => reject(order, reason)}
      />
    </div>
  );
}

/**
 * Three different "nothing here" states, because they mean three different
 * things and only one of them is good news.
 */
function QueueEmpty({ mode }: { mode: OrderMode | null }) {
  const t = useTranslations();
  if (mode === "disabled") {
    return (
      <OrdersEmptyState
        title={t.orders.queue.disabledTitle}
        body={t.orders.queue.disabledBody}
      />
    );
  }
  if (mode === "auto") {
    return (
      <OrdersEmptyState
        title={t.orders.queue.autoTitle}
        body={t.orders.queue.autoBody}
      />
    );
  }
  return (
    <OrdersEmptyState
      title={t.orders.queue.emptyTitle}
      body={t.orders.queue.emptyBody}
    />
  );
}
