"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, PackageOpen, RotateCw, Settings2 } from "lucide-react";
import {
  COURIERS,
  ORDER_STATUSES,
  SHIPMENT_STATUSES,
  loadShipmentPage,
  type Courier,
  type OrderStatus,
  type ShipmentPage,
  type ShipmentStatus,
} from "@/lib/api/delivery";
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
import { ShipmentListRow } from "./shipment-row";
import { courierLabel, orderStatusLabel, shipmentStatusLabel } from "./format";

type CourierFilter = Courier | "all";
type StatusFilter = ShipmentStatus | "all";
type OrderStatusFilter = OrderStatus | "all";

/**
 * The deliveries screen.
 *
 * F26 ships no tenant-wide shipment list — `GET /orders/:orderId/shipments`
 * is the only read — so this pages over orders and gathers their shipments.
 * That has a consequence the UI must not hide: **order status is a server
 * filter, courier and shipment status are not.** They narrow the orders
 * already fetched, and the result count says exactly how many orders were
 * searched to produce it. Presenting a client-side filter as if the server
 * had run it is how a support agent concludes a shipment doesn't exist.
 */
export function ShipmentsExplorer({
  initial,
  initialOrderStatus,
}: {
  initial: ShipmentPage;
  initialOrderStatus: OrderStatusFilter;
}) {
  const t = useTranslations();

  const [page, setPage] = useState(initial);
  const [orderStatus, setOrderStatus] =
    useState<OrderStatusFilter>(initialOrderStatus);
  const [courier, setCourier] = useState<CourierFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [pending, setPending] = useState<"reload" | "more" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function reload(next: OrderStatusFilter) {
    setOrderStatus(next);
    setPending("reload");
    setLoadError(null);
    try {
      const result = await loadShipmentPage({
        status: next === "all" ? undefined : next,
      });
      setPage(result);
      setExpandedId(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, t, t.delivery.list.couldNotLoad));
    } finally {
      setPending(null);
    }
  }

  async function loadMore() {
    if (!page.nextCursor) return;
    setPending("more");
    setLoadError(null);
    try {
      const result = await loadShipmentPage({
        status: orderStatus === "all" ? undefined : orderStatus,
        cursor: page.nextCursor,
      });
      setPage((prev) => ({
        rows: [...prev.rows, ...result.rows],
        ordersScanned: prev.ordersScanned + result.ordersScanned,
        nextCursor: result.nextCursor,
      }));
    } catch (err) {
      setLoadError(apiErrorMessage(err, t, t.delivery.list.couldNotLoad));
    } finally {
      setPending(null);
    }
  }

  const visible = page.rows.filter(
    (row) =>
      (courier === "all" || row.shipment.courier === courier) &&
      (status === "all" || row.shipment.currentStatus === status),
  );

  const localFiltered = courier !== "all" || status !== "all";
  const anyFilter = localFiltered || orderStatus !== "all";

  function clearFilters() {
    setCourier("all");
    setStatus("all");
    if (orderStatus !== "all") void reload("all");
  }

  const orderStatusText =
    orderStatus === "all"
      ? t.delivery.list.all
      : orderStatusLabel(t, orderStatus);
  const courierText =
    courier === "all" ? t.delivery.list.all : courierLabel(courier);
  const statusText =
    status === "all" ? t.delivery.list.all : shipmentStatusLabel(t, status);

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-border bg-card/60 p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="deliveries-order-status">
                {t.delivery.list.orderStatusLabel}
              </Label>
              <Select
                value={orderStatus}
                onValueChange={(value) => void reload(value as OrderStatusFilter)}
                disabled={pending !== null}
              >
                <SelectTrigger id="deliveries-order-status" className="w-48">
                  <SelectValue>{() => orderStatusText}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t.delivery.list.all}</SelectItem>
                  {ORDER_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {orderStatusLabel(t, value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deliveries-courier">
                {t.delivery.list.courierLabel}
              </Label>
              <Select
                value={courier}
                onValueChange={(value) => setCourier(value as CourierFilter)}
              >
                <SelectTrigger id="deliveries-courier" className="w-44">
                  <SelectValue>{() => courierText}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t.delivery.list.all}</SelectItem>
                  {COURIERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {courierLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deliveries-shipment-status">
                {t.delivery.list.shipmentStatusLabel}
              </Label>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as StatusFilter)}
              >
                <SelectTrigger id="deliveries-shipment-status" className="w-48">
                  <SelectValue>{() => statusText}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t.delivery.list.all}</SelectItem>
                  {SHIPMENT_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {shipmentStatusLabel(t, value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {anyFilter ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t.delivery.list.clearFilters}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void reload(orderStatus)}
              disabled={pending !== null}
            >
              {pending === "reload" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCw className="size-3.5" aria-hidden />
              )}
              {t.delivery.list.refresh}
            </Button>
          </div>
        </div>

        <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
          {t.delivery.list.serverFilterNote}
        </p>
      </section>

      {loadError ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {loadError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
          {t.delivery.list.countTemplate
            .replace("{shown}", String(visible.length))
            .replace("{loaded}", String(page.rows.length))
            .replace("{orders}", String(page.ordersScanned))}
        </p>
        <Link
          href="/settings/delivery"
          className="inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Settings2 className="size-3.5" aria-hidden />
          {t.delivery.list.settingsLink}
        </Link>
      </div>

      {visible.length === 0 ? (
        <EmptyState filtered={localFiltered || orderStatus !== "all"} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {visible.map((row) => (
            <ShipmentListRow
              key={row.shipment.id}
              row={row}
              expanded={expandedId === row.shipment.id}
              onToggle={() =>
                setExpandedId((prev) =>
                  prev === row.shipment.id ? null : row.shipment.id,
                )
              }
            />
          ))}
        </ul>
      )}

      {page.nextCursor ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void loadMore()}
            disabled={pending !== null}
          >
            {pending === "more" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {pending === "more"
              ? t.delivery.list.loading
              : t.delivery.list.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Two different nothings, and conflating them is a support incident: "you
 * have no shipments at all" is a setup story, "nothing here matches" is a
 * filter story that also has to admit only the loaded orders were searched.
 */
function EmptyState({ filtered }: { filtered: boolean }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border px-6 py-10">
      <PackageOpen className="size-5 text-muted-foreground" aria-hidden />
      <h3 className="font-display text-lg font-medium tracking-tight">
        {filtered
          ? t.delivery.list.emptyFilteredTitle
          : t.delivery.list.emptyTitle}
      </h3>
      <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
        {filtered ? t.delivery.list.emptyFilteredBody : t.delivery.list.emptyBody}
      </p>
      {filtered ? null : (
        <Button variant="outline" size="sm" render={<Link href="/settings/delivery" />}>
          <Settings2 className="size-3.5" aria-hidden />
          {t.delivery.list.emptyHint}
        </Button>
      )}
    </div>
  );
}
