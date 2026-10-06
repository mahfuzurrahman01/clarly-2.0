"use client";

import Link from "next/link";
import { MessageSquare } from "lucide-react";
import type { OrderView } from "@/lib/api/orders";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { formatDateTime, formatMoney } from "./format";
import {
  NotNotifiedBadge,
  OrderStatusBadge,
  StoreSyncBadge,
} from "./order-badges";

/** A decided order the customer was never able to be told about. */
function isSilentlyDecided(order: OrderView): boolean {
  return (
    order.customerNotifiedAt === null &&
    (order.status === "confirmed" ||
      order.status === "rejected" ||
      order.status === "cancelled")
  );
}

/**
 * The orders table. Kept as a real `<table>` at every width — overriding
 * `display` on table elements is what breaks table semantics for screen
 * readers — so narrow screens drop the two lowest-value columns (store sync,
 * placed-at) instead of restyling rows into cards.
 */
export function OrderTable({ orders }: { orders: OrderView[] }) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <div className="relative overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[38rem] text-sm">
        <caption className="sr-only">{t.orders.list.tableCaption}</caption>
        <thead className="bg-secondary/60 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2 text-start font-medium">
              {t.orders.list.colReference}
            </th>
            <th scope="col" className="px-4 py-2 text-start font-medium">
              {t.orders.list.colCustomer}
            </th>
            <th scope="col" className="px-4 py-2 text-start font-medium">
              {t.orders.list.colStatus}
            </th>
            <th
              scope="col"
              className="hidden px-4 py-2 text-start font-medium lg:table-cell"
            >
              {t.orders.list.colSync}
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              {t.orders.list.colTotal}
            </th>
            <th
              scope="col"
              className="hidden px-4 py-2 text-start font-medium md:table-cell"
            >
              {t.orders.list.colCreated}
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              <span className="sr-only">{t.orders.list.colActions}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {orders.map((order) => (
            <tr key={order.id} className="align-top">
              <td className="px-4 py-3">
                <Link
                  href={`/orders/${order.id}`}
                  className="font-medium tabular-nums underline-offset-4 hover:underline focus-visible:underline"
                >
                  {order.reference}
                </Link>
              </td>
              <td className="px-4 py-3">
                <span className="block">{order.contactName}</span>
                <span
                  className="block text-xs text-muted-foreground tabular-nums"
                  dir="ltr"
                >
                  {order.contactPhone}
                </span>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <OrderStatusBadge status={order.status} />
                  {isSilentlyDecided(order) ? <NotNotifiedBadge /> : null}
                </div>
              </td>
              <td className="hidden px-4 py-3 lg:table-cell">
                <StoreSyncBadge status={order.storeSyncStatus} />
              </td>
              <td className="px-4 py-3 text-end tabular-nums">
                {formatMoney(order.total, order.currency, locale)}
              </td>
              <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                {formatDateTime(order.createdAt, locale)}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-3">
                  {order.conversationId ? (
                    <Link
                      href={`/inbox/${order.conversationId}`}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline"
                    >
                      <MessageSquare className="size-3.5" aria-hidden="true" />
                      {t.orders.list.openChat}
                    </Link>
                  ) : null}
                  <Link
                    href={`/orders/${order.id}`}
                    className="text-xs underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {t.orders.list.view}
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
