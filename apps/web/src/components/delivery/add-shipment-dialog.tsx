"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_TRACKING_NUMBER_LENGTH,
  createOrderShipment,
  type CourierConnection,
  type Shipment,
} from "@/lib/api/delivery";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LtrToken } from "./ltr-token";
import { courierLabel } from "./format";

function connectionText(connection: CourierConnection): string {
  return `${courierLabel(connection.courier)} · ${connection.accountRef}`;
}

/**
 * Records a tracking number against an order — the console entry point F26
 * was missing, and the only way a shipment row comes into existence today.
 *
 * The merchant picks a *connection*, not a courier: the API needs both and
 * 400s when they disagree, so deriving `courier` from the chosen connection
 * makes that mismatch impossible to submit. Only active connections are
 * offered — an inactive one is a guaranteed 400, and its shipment would never
 * be polled anyway.
 */
export function AddShipmentDialog({
  open,
  orderId,
  orderReference,
  connections,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  orderId: string;
  orderReference: string;
  /** Active connections only; the caller filters. */
  connections: CourierConnection[];
  onOpenChange: (open: boolean) => void;
  onCreated: (shipment: Shipment) => void;
}) {
  const t = useTranslations();
  const copy = t.delivery.shipmentForm;
  const [connectionId, setConnectionId] = useState<string | null>(
    connections.length === 1 ? connections[0].id : null,
  );
  const [trackingNumber, setTrackingNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected =
    connections.find((connection) => connection.id === connectionId) ?? null;

  function close() {
    onOpenChange(false);
    // Reset after the close transition so the panel doesn't visibly empty.
    setTimeout(() => {
      setTrackingNumber("");
      setError(null);
      setConnectionId(connections.length === 1 ? connections[0].id : null);
    }, 200);
  }

  async function submit() {
    const trimmed = trackingNumber.trim();
    if (!selected) {
      setError(copy.courierRequired);
      return;
    }
    if (!trimmed) {
      setError(copy.trackingRequired);
      return;
    }
    if (trimmed.length > MAX_TRACKING_NUMBER_LENGTH) {
      setError(copy.trackingTooLong);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const shipment = await createOrderShipment(orderId, {
        courier: selected.courier,
        courierConnectionId: selected.id,
        trackingNumber: trimmed,
      });
      toast.success(copy.created);
      onCreated(shipment);
      close();
    } catch (err) {
      setError(apiErrorMessage(err, t, copy.couldNotCreate));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {copy.descriptionPrefix}{" "}
            <LtrToken tabular>{orderReference}</LtrToken>
            {copy.descriptionSuffix}
          </DialogDescription>
        </DialogHeader>

        {connections.length === 0 ? (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">{copy.noConnections}</p>
            <Link
              href="/settings/delivery"
              className="underline-offset-4 hover:underline focus-visible:underline"
            >
              {t.delivery.list.settingsLink}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="shipment-courier">{copy.courierLabel}</Label>
              <Select
                value={connectionId}
                onValueChange={(value) => setConnectionId(value as string)}
              >
                <SelectTrigger id="shipment-courier" className="w-full">
                  <SelectValue>
                    {() =>
                      selected ? (
                        <LtrToken>{connectionText(selected)}</LtrToken>
                      ) : (
                        copy.courierPlaceholder
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      <LtrToken>{connectionText(connection)}</LtrToken>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shipment-tracking">{copy.trackingLabel}</Label>
              <Input
                id="shipment-tracking"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={trackingNumber}
                maxLength={MAX_TRACKING_NUMBER_LENGTH}
                onChange={(e) => setTrackingNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                aria-describedby="shipment-tracking-hint"
                aria-invalid={error !== null}
              />
              <p
                id="shipment-tracking-hint"
                className="text-xs text-muted-foreground"
              >
                {copy.trackingHint}
              </p>
            </div>

            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={saving}>
            {copy.cancel}
          </Button>
          {connections.length > 0 ? (
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {copy.submit}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
