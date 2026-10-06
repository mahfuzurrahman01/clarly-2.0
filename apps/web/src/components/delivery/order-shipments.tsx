"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import {
  loadOrderShipments,
  type OrderShipmentsData,
  type Shipment,
} from "@/lib/api/delivery";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { AddShipmentDialog } from "./add-shipment-dialog";
import { LtrToken } from "./ltr-token";
import { ShipmentStatusBadge } from "./shipment-status-badge";
import { courierLabel } from "./format";

/**
 * Order statuses a parcel can plausibly leave under. The API does not gate on
 * order status, so this is a console rule: a pending, rejected, expired or
 * cancelled order was never agreed to ship, and a tracking number on it would
 * start billed customer notifications for an order the merchant refused.
 */
const SHIPPABLE_STATUSES = new Set(["confirmed", "fulfilled"]);

/**
 * The order detail's shipment card: what has been recorded against this
 * order, and the button that records another.
 */
export function OrderShipments({
  orderId,
  orderReference,
  orderStatus,
  initialData,
}: {
  orderId: string;
  orderReference: string;
  orderStatus: string;
  /** From the server page; `null` means that read failed and a retry is offered. */
  initialData: OrderShipmentsData | null;
}) {
  const t = useTranslations();
  const copy = t.delivery.shipmentForm;
  const [data, setData] = useState<OrderShipmentsData | null>(initialData);
  const [error, setError] = useState<string | null>(
    initialData ? null : copy.couldNotLoad,
  );
  const [retrying, setRetrying] = useState(false);
  const [adding, setAdding] = useState(false);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      setData(await loadOrderShipments(orderId));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, t, copy.couldNotLoad));
    } finally {
      setRetrying(false);
    }
  }, [orderId, t, copy.couldNotLoad]);

  const canAdd = SHIPPABLE_STATUSES.has(orderStatus);

  function onCreated(shipment: Shipment) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            // The API upserts on tracking number, so a re-submit returns an
            // existing row — replace it rather than list it twice.
            shipments: [
              ...prev.shipments.filter((s) => s.id !== shipment.id),
              shipment,
            ],
          }
        : prev,
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg font-medium tracking-tight">
        {copy.sectionTitle}
      </h2>
      <div className="space-y-3 rounded-xl border border-border p-4">
        {error || data === null ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {error ?? copy.couldNotLoad}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.delivery.list.refresh}
            </Button>
          </div>
        ) : (
          <>
            {data.shipments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{copy.none}</p>
            ) : (
              <ul className="space-y-3">
                {data.shipments.map((shipment) => (
                  <li key={shipment.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <LtrToken className="text-sm font-medium" tabular>
                        {shipment.trackingNumber}
                      </LtrToken>
                      <ShipmentStatusBadge status={shipment.currentStatus} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <LtrToken>{courierLabel(shipment.courier)}</LtrToken>
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {data.shipments.length > 0 ? (
              <Link
                href="/deliveries"
                className="block text-sm underline-offset-4 hover:underline focus-visible:underline"
              >
                {copy.viewAll}
              </Link>
            ) : null}

            {canAdd ? (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus className="size-4" />
                {copy.open}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {copy.notShippable}
              </p>
            )}
          </>
        )}
      </div>

      {data ? (
        <AddShipmentDialog
          open={adding}
          orderId={orderId}
          orderReference={orderReference}
          connections={data.connections}
          onOpenChange={setAdding}
          onCreated={onCreated}
        />
      ) : null}
    </section>
  );
}
