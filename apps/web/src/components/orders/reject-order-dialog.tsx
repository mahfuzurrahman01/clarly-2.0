"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { MAX_REJECTION_REASON_LENGTH, type OrderView } from "@/lib/api/orders";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fill } from "./format";

const textareaClass =
  "w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40";

/**
 * Rejection is the one order action that cannot be undone from the console
 * and that requires a typed reason, so it gets a dialog while approve does
 * not (approve is reversible: a `confirmed` order can still be cancelled).
 *
 * The reason is **merchant-internal** — the customer receives a neutral
 * message and never sees this text. That's stated in the dialog, because a
 * reason written for the customer would be written very differently.
 */
export function RejectOrderDialog({
  order,
  submitting,
  onOpenChange,
  onConfirm,
}: {
  /** The order being rejected; `null` closes the dialog. */
  order: OrderView | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the rejection went through, so the dialog can close. */
  onConfirm: (order: OrderView, reason: string) => Promise<boolean>;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function close() {
    onOpenChange(false);
    // Reset after the close transition so the panel doesn't visibly empty.
    setTimeout(() => {
      setReason("");
      setError(null);
    }, 200);
  }

  async function submit() {
    if (!order) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(t.orders.reject.reasonRequired);
      return;
    }
    if (trimmed.length > MAX_REJECTION_REASON_LENGTH) {
      setError(t.orders.reject.reasonTooLong);
      return;
    }
    setError(null);
    if (await onConfirm(order, trimmed)) close();
  }

  const remaining = MAX_REJECTION_REASON_LENGTH - reason.trim().length;

  return (
    <Dialog
      open={order !== null}
      onOpenChange={(next) => (next ? null : close())}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.orders.reject.title}</DialogTitle>
          <DialogDescription>
            {order
              ? fill(t.orders.reject.descriptionTemplate, {
                  reference: order.reference,
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="order-reject-reason">
            {t.orders.reject.reasonLabel}
          </Label>
          <textarea
            id="order-reject-reason"
            rows={3}
            value={reason}
            maxLength={MAX_REJECTION_REASON_LENGTH}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t.orders.reject.reasonPlaceholder}
            aria-describedby="order-reject-hint"
            aria-invalid={error !== null}
            className={textareaClass}
          />
          <p
            id="order-reject-hint"
            className="text-xs text-muted-foreground"
          >
            {t.orders.reject.reasonHint}
          </p>
          {remaining < 50 ? (
            <p className="text-xs text-muted-foreground tabular-nums" role="status">
              {remaining}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            {t.orders.reject.cancel}
          </Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t.orders.reject.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
