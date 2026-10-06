"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, X } from "lucide-react";
import {
  ORDERS_PAGE_SIZE,
  ORDER_STATUSES,
  ORDER_STORE_SYNC_STATUSES,
  listOrders,
  type OrderPage,
  type OrderStatus,
  type StoreSyncStatus,
} from "@/lib/api/orders";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OrderTable } from "./order-table";
import { fill } from "./format";

type StatusFilter = OrderStatus | "all";
type SyncFilter = StoreSyncStatus | "all";

/**
 * The "All orders" tab. The server component hands over page 1; every filter
 * and page after that goes through the browser client.
 *
 * Paging is **keyset**, not offset: the API returns an opaque `nextCursor`
 * and no total count. Going forward is a cursor; going back is remembering
 * the cursor that produced each page, which is what `cursors` is — index 0 is
 * `undefined` (page 1 has no cursor). Re-deriving "previous" from a cursor is
 * not possible, so it has to be kept.
 */
export function OrdersList({
  initial,
  customerId,
  conversationId,
}: {
  initial: OrderPage;
  /** Locked filters arriving from the URL (e.g. "other orders from this customer"). */
  customerId?: string;
  conversationId?: string;
}) {
  const t = useTranslations();
  const router = useRouter();

  const [orders, setOrders] = useState(initial.orders);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sync, setSync] = useState<SyncFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Page 1 with no filters is already on screen from the server render.
  const skipFirstFetch = useRef(true);

  useEffect(() => {
    if (skipFirstFetch.current) {
      skipFirstFetch.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    listOrders({
      status: status === "all" ? undefined : status,
      storeSyncStatus: sync === "all" ? undefined : sync,
      customerId,
      conversationId,
      cursor: cursors[page],
      limit: ORDERS_PAGE_SIZE,
    })
      .then((result) => {
        if (cancelled) return;
        setOrders(result.orders);
        setNextCursor(result.nextCursor);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(apiErrorMessage(err, t, t.orders.list.couldNotLoad));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is stable for the session (server-resolved dictionary).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sync, page, cursors, customerId, conversationId]);

  /** Any filter change invalidates every cursor already collected. */
  const resetPaging = useCallback(() => {
    setCursors([undefined]);
    setPage(0);
  }, []);

  function changeStatus(value: StatusFilter) {
    setStatus(value);
    resetPaging();
  }

  function changeSync(value: SyncFilter) {
    setSync(value);
    resetPaging();
  }

  function goNext() {
    if (!nextCursor) return;
    setCursors((prev) => {
      const copy = [...prev];
      copy[page + 1] = nextCursor;
      return copy;
    });
    setPage((current) => current + 1);
  }

  const statusLabels: Record<StatusFilter, string> = {
    all: t.orders.list.filterStatusAll,
    pending_approval: t.orders.status.pending_approval,
    confirmed: t.orders.status.confirmed,
    rejected: t.orders.status.rejected,
    expired: t.orders.status.expired,
    cancelled: t.orders.status.cancelled,
    fulfilled: t.orders.status.fulfilled,
    failed: t.orders.status.failed,
  };

  const syncLabels: Record<SyncFilter, string> = {
    all: t.orders.list.filterSyncAll,
    not_applicable: t.orders.sync.not_applicable,
    pending: t.orders.sync.pending,
    synced: t.orders.sync.synced,
    failed: t.orders.sync.failed,
  };

  const scoped = Boolean(customerId || conversationId);
  const filtered = status !== "all" || sync !== "all";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="orders-status-filter">
            {t.orders.list.filterStatusLabel}
          </Label>
          <Select
            value={status}
            onValueChange={(value) => changeStatus(value as StatusFilter)}
          >
            <SelectTrigger id="orders-status-filter" className="w-48">
              <SelectValue>{() => statusLabels[status]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{statusLabels.all}</SelectItem>
              {ORDER_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {statusLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="orders-sync-filter">
            {t.orders.list.filterSyncLabel}
          </Label>
          <Select
            value={sync}
            onValueChange={(value) => changeSync(value as SyncFilter)}
          >
            <SelectTrigger id="orders-sync-filter" className="w-48">
              <SelectValue>{() => syncLabels[sync]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{syncLabels.all}</SelectItem>
              {ORDER_STORE_SYNC_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {syncLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {scoped ? (
          <div className="flex items-center gap-2 rounded-full border border-border bg-secondary/60 py-1 ps-3 pe-1 text-xs">
            <span>
              {customerId
                ? t.orders.list.scopedCustomer
                : t.orders.list.scopedConversation}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 rounded-full px-2"
              onClick={() => router.replace("/orders")}
            >
              <X className="size-3" />
              {t.orders.list.clearScope}
            </Button>
          </div>
        ) : null}
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {loadError}
        </p>
      ) : null}

      <div
        aria-busy={loading}
        className={loading ? "opacity-60 transition-opacity" : undefined}
      >
        {orders.length > 0 ? (
          <OrderTable orders={orders} />
        ) : filtered || scoped ? (
          <EmptyState
            title={t.orders.list.emptyFilteredTitle}
            body={t.orders.list.emptyFilteredBody}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus("all");
                  setSync("all");
                  resetPaging();
                  if (scoped) router.replace("/orders");
                }}
              >
                {t.orders.list.clearFilters}
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={t.orders.list.emptyTitle}
            body={t.orders.list.emptyBody}
          />
        )}
      </div>

      {orders.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums" role="status">
            {fill(t.orders.list.showingTemplate, { count: orders.length })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0 || loading}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              {t.orders.list.previousPage}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!nextCursor || loading}
              onClick={goNext}
            >
              {t.orders.list.nextPage}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border px-6 py-10">
      <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1.5">
        <h3 className="font-display text-lg font-medium tracking-tight">
          {title}
        </h3>
        <p className="max-w-prose text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

/** Re-exported so the approval queue shows the same empty treatment. */
export { EmptyState as OrdersEmptyState };
