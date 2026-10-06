"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  ApiError,
} from "@/lib/api/client";
import {
  createBooking,
  getAvailability,
  type Availability,
  type Booking,
  type BookingServiceItem,
} from "@/lib/api/bookings";
import { apiErrorMessage } from "@/lib/api/error-message";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A booking the team adds for a phone or walk-in customer. Free times are
 * fetched for the chosen day and offered as chips, but any time may be
 * typed: the console may book outside opening hours (the API still refuses
 * an overlap with 409 `taken`).
 */
export function NewBookingDialog({
  open,
  onOpenChange,
  services,
  defaultDate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: BookingServiceItem[];
  defaultDate: string;
  onCreated: (booking: Booking) => void;
}) {
  const t = useTranslations();
  const active = services.filter((s) => s.active);
  const [serviceId, setServiceId] = useState(active[0]?.id ?? "");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  // Keyed by `${serviceId}|${date}` so "loading" is derived (the key asked for
  // is not the key loaded yet) instead of set synchronously inside the effect.
  const [loaded, setLoaded] = useState<{ key: string; availability: Availability | null } | null>(null);
  const slotKey = `${serviceId}|${date}`;
  const canFetch = open && !!serviceId && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const loadingSlots = canFetch && loaded?.key !== slotKey;
  const availability = loaded?.key === slotKey ? loaded.availability : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    getAvailability(serviceId, date)
      .then((a) => {
        if (!cancelled) setLoaded({ key: `${serviceId}|${date}`, availability: a });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: `${serviceId}|${date}`, availability: null });
      });
    return () => {
      cancelled = true;
    };
  }, [canFetch, serviceId, date]);

  function reset() {
    setTime("");
    setName("");
    setPhone("");
    setEmail("");
    setNotes("");
    setError(null);
  }

  async function submit() {
    if (!serviceId || !date || !/^\d{2}:\d{2}$/.test(time) || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const booking = await createBooking({
        serviceId,
        date,
        time,
        customerName: name.trim(),
        customerPhone: phone.trim() || null,
        customerEmail: email.trim() || null,
        notes: notes.trim() || null,
      });
      onCreated(booking);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t.bookings.newDialog.taken
          : apiErrorMessage(err, t, t.bookings.toasts.failed),
      );
    } finally {
      setSaving(false);
    }
  }

  const serviceName = active.find((s) => s.id === serviceId)?.name ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.bookings.newDialog.title}</DialogTitle>
          <DialogDescription>{t.bookings.newDialog.description}</DialogDescription>
        </DialogHeader>

        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.bookings.newDialog.noServices}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="nb-service">{t.bookings.newDialog.service}</Label>
              <Select value={serviceId} onValueChange={(v) => setServiceId(v as string)}>
                <SelectTrigger id="nb-service" className="w-full">
                  <SelectValue>{() => serviceName}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {active.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-date">{t.bookings.newDialog.date}</Label>
                <Input id="nb-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-time">{t.bookings.newDialog.time}</Label>
                <Input id="nb-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} dir="ltr" />
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t.bookings.newDialog.freeTimes}</p>
              {loadingSlots ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : availability && availability.slots.length > 0 ? (
                <div className="flex flex-wrap gap-1.5" dir="ltr">
                  {availability.slots.map((slot) => (
                    <button
                      key={slot.time}
                      type="button"
                      onClick={() => setTime(slot.time)}
                      className={cn(
                        "rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                        time === slot.time
                          ? "border-lime-ring bg-lime-soft/70"
                          : "border-border hover:bg-secondary",
                      )}
                    >
                      {slot.time}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t.bookings.newDialog.noFreeTimes}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nb-name">{t.bookings.newDialog.customerName}</Label>
              <Input id="nb-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-phone">{t.bookings.newDialog.customerPhone}</Label>
                <Input id="nb-phone" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-email">{t.bookings.newDialog.customerEmail}</Label>
                <Input id="nb-email" type="email" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nb-notes">{t.bookings.newDialog.notes}</Label>
              <Input id="nb-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            onClick={submit}
            disabled={saving || active.length === 0 || !name.trim() || !/^\d{2}:\d{2}$/.test(time)}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t.bookings.newDialog.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
