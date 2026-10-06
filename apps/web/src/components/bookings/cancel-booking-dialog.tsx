"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { Booking } from "@/lib/api/bookings";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

const textareaClass =
  "w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40";

export function CancelBookingDialog({
  booking,
  submitting,
  onOpenChange,
  onConfirm,
}: {
  booking: Booking | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (booking: Booking, reason: string) => Promise<boolean>;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");

  function close() {
    onOpenChange(false);
    setTimeout(() => setReason(""), 200);
  }

  async function submit() {
    if (!booking) return;
    if (await onConfirm(booking, reason.trim())) close();
  }

  return (
    <Dialog open={booking !== null} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.bookings.cancelDialog.title}</DialogTitle>
          <DialogDescription>{t.bookings.cancelDialog.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="booking-cancel-reason">{t.bookings.cancelDialog.reasonLabel}</Label>
          <textarea
            id="booking-cancel-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={textareaClass}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            {t.bookings.cancelDialog.keep}
          </Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t.bookings.cancelDialog.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
