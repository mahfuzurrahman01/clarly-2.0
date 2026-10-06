"use client";

import { useState } from "react";
import { Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import {
  BOOKING_LOCATIONS,
  createBookingService,
  updateBookingService,
  type BookingLocation,
  type BookingServiceItem,
} from "@/lib/api/bookings";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatPrice } from "./format";

type Draft = {
  id: string | null;
  name: string;
  description: string;
  duration: string;
  buffer: string;
  price: string;
  currency: string;
  location: BookingLocation;
  active: boolean;
};

const EMPTY: Draft = {
  id: null,
  name: "",
  description: "",
  duration: "30",
  buffer: "0",
  price: "",
  currency: "",
  location: "in_person",
  active: true,
};

export function BookingServicesManager({
  initial,
  canEdit,
  defaultCurrency,
}: {
  initial: BookingServiceItem[];
  canEdit: boolean;
  defaultCurrency: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [services, setServices] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open(service?: BookingServiceItem) {
    setError(null);
    setDraft(
      service
        ? {
            id: service.id,
            name: service.name,
            description: service.description ?? "",
            duration: String(service.durationMinutes),
            buffer: String(service.bufferMinutes),
            price: service.price ?? "",
            currency: service.currency ?? "",
            location: service.location,
            active: service.active,
          }
        : { ...EMPTY, currency: defaultCurrency ?? "" },
    );
  }

  const valid =
    draft !== null &&
    draft.name.trim().length > 0 &&
    Number(draft.duration) >= 5 && Number(draft.duration) <= 480 &&
    Number(draft.buffer) >= 0 && Number(draft.buffer) <= 240 &&
    (draft.price.trim() === "" || Number(draft.price) >= 0) &&
    (draft.currency.trim() === "" || /^[A-Za-z]{3}$/.test(draft.currency.trim()));

  async function save() {
    if (!draft || !valid) return;
    setSaving(true);
    setError(null);
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      durationMinutes: Number(draft.duration),
      bufferMinutes: Number(draft.buffer),
      price: draft.price.trim() === "" ? null : Number(draft.price),
      currency: draft.currency.trim() === "" ? null : draft.currency.trim().toUpperCase(),
      location: draft.location,
      active: draft.active,
    };
    try {
      const saved = draft.id
        ? await updateBookingService(draft.id, body)
        : await createBookingService(body);
      setServices((prev) =>
        (draft.id ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved]).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setDraft(null);
      toast.success(t.bookings.services.saved);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t.bookings.services.duplicate
          : apiErrorMessage(err, t, t.bookings.services.couldNotSave),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-medium tracking-tight">{t.bookings.services.title}</h2>
          <p className="text-sm text-muted-foreground">{t.bookings.services.description}</p>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => open()}>
            <Plus className="size-4" />
            {t.bookings.services.add}
          </Button>
        ) : null}
      </div>

      {services.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t.bookings.services.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {services.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className={cn("truncate text-sm font-medium", !s.active && "text-muted-foreground line-through")}>
                  {s.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.bookings.when.minutes.replace("{n}", String(s.durationMinutes))} ·{" "}
                  {formatPrice(s.price, s.currency, locale) ?? t.bookings.services.priceOnRequest} ·{" "}
                  {t.bookings.location[s.location]}
                  {!s.active ? ` · ${t.bookings.services.inactive}` : ""}
                </p>
              </div>
              {canEdit ? (
                <Button variant="ghost" size="sm" onClick={() => open(s)}>
                  <Pencil className="size-4" />
                  {t.bookings.services.edit}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => (o ? null : setDraft(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t.bookings.services.edit : t.bookings.services.add}</DialogTitle>
          </DialogHeader>
          {draft ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="svc-name">{t.bookings.services.name}</Label>
                <Input id="svc-name" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="svc-desc">{t.bookings.services.serviceDescription}</Label>
                <Input id="svc-desc" value={draft.description} maxLength={1000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="svc-duration">{t.bookings.services.duration}</Label>
                  <Input id="svc-duration" type="number" min={5} max={480} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="svc-buffer">{t.bookings.services.buffer}</Label>
                  <Input id="svc-buffer" type="number" min={0} max={240} value={draft.buffer} onChange={(e) => setDraft({ ...draft, buffer: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="svc-price">{t.bookings.services.price}</Label>
                  <Input id="svc-price" type="number" min={0} step="0.01" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} dir="ltr" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="svc-currency">{t.bookings.services.currency}</Label>
                  <Input id="svc-currency" value={draft.currency} maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} className="font-mono uppercase" dir="ltr" />
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t.bookings.services.location}</p>
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {BOOKING_LOCATIONS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setDraft({ ...draft, location: l })}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-sm transition-colors",
                        draft.location === l ? "bg-lime-soft/70 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t.bookings.location[l]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                {t.bookings.services.active}
              </label>
              {error ? (
                <p role="alert" className="text-sm text-destructive">{error}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={save} disabled={!valid || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.bookings.services.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
