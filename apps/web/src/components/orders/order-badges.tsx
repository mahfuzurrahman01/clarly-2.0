"use client";

import {
  AlertTriangle,
  BellOff,
  CheckCircle2,
  CircleSlash,
  Clock,
  PackageCheck,
  Store,
  TimerOff,
  XCircle,
} from "lucide-react";
import type { OrderStatus, StoreSyncStatus } from "@/lib/api/orders";
import { useTranslations } from "@/lib/i18n/provider";

/**
 * Status is carried by colour AND an icon AND a word — the same rule the
 * catalog's stock badge follows, and for the same reason: "is this red or
 * green" is not a signal everyone gets.
 *
 * The two badges are deliberately separate components because `status` and
 * `storeSyncStatus` are separate lifecycles. Collapsing them into one chip
 * would let a store outage read as a cancelled order.
 */

const base =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap";

const STATUS_STYLES: Record<OrderStatus, string> = {
  pending_approval: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  confirmed: "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
  fulfilled: "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
  rejected: "border-destructive/40 bg-destructive/5 text-destructive",
  failed: "border-destructive/40 bg-destructive/5 text-destructive",
  expired: "border-border bg-secondary text-muted-foreground",
  cancelled: "border-border bg-secondary text-muted-foreground",
};

const STATUS_ICONS: Record<OrderStatus, typeof Clock> = {
  pending_approval: Clock,
  confirmed: CheckCircle2,
  fulfilled: PackageCheck,
  rejected: XCircle,
  failed: AlertTriangle,
  expired: TimerOff,
  cancelled: CircleSlash,
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations();
  const Icon = STATUS_ICONS[status];
  return (
    <span className={`${base} ${STATUS_STYLES[status]}`}>
      <Icon className="size-3" aria-hidden="true" />
      {t.orders.status[status]}
    </span>
  );
}

const SYNC_STYLES: Record<StoreSyncStatus, string> = {
  not_applicable: "border-border bg-transparent text-muted-foreground",
  pending: "border-border bg-secondary text-muted-foreground",
  synced: "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
  failed: "border-destructive/40 bg-destructive/5 text-destructive",
};

export function StoreSyncBadge({ status }: { status: StoreSyncStatus }) {
  const t = useTranslations();
  // "No store connected" is the normal state for most workspaces — a badge
  // for it would be noise on every single row.
  if (status === "not_applicable") {
    return (
      <span className="text-xs text-muted-foreground">
        {t.orders.sync.not_applicable}
      </span>
    );
  }
  const Icon = status === "failed" ? AlertTriangle : Store;
  return (
    <span className={`${base} ${SYNC_STYLES[status]}`}>
      <Icon className="size-3" aria-hidden="true" />
      {t.orders.sync[status]}
    </span>
  );
}

/**
 * A decided order whose customer was never told, because the WhatsApp 24h
 * service window had closed. The merchant has to reach out by other means,
 * so this is never left implicit.
 */
export function NotNotifiedBadge() {
  const t = useTranslations();
  return (
    <span
      className={`${base} border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400`}
      title={t.orders.list.notNotifiedHint}
    >
      <BellOff className="size-3" aria-hidden="true" />
      {t.orders.list.notNotified}
    </span>
  );
}
