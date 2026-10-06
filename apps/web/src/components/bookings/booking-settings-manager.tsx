"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BOOKING_MODES,
  BOOKING_WEEKDAYS,
  updateBookingSettings,
  type BookingMode,
  type BookingSettings,
  type BookingWeekday,
  type OpeningWindow,
  type WeeklyHours,
} from "@/lib/api/bookings";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const MAX_WINDOWS = 3;

/** The week as the GCC reads it: Saturday/Sunday first is a choice; we keep the API's Sunday-first order. */
function cloneHours(hours: WeeklyHours): WeeklyHours {
  const out: WeeklyHours = {};
  for (const day of BOOKING_WEEKDAYS) {
    if (hours[day]?.length) out[day] = hours[day]!.map((w) => ({ ...w }));
  }
  return out;
}

function windowValid(w: OpeningWindow): boolean {
  return /^\d{2}:\d{2}$/.test(w.open) && /^\d{2}:\d{2}$/.test(w.close) && w.close > w.open;
}

export function BookingSettingsManager({
  initial,
  canEdit,
}: {
  initial: BookingSettings;
  canEdit: boolean;
}) {
  const t = useTranslations();
  const [saved, setSaved] = useState(initial);
  const [mode, setMode] = useState<BookingMode>(initial.mode);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [hours, setHours] = useState<WeeklyHours>(cloneHours(initial.weeklyHours));
  const [grid, setGrid] = useState(String(initial.slotIntervalMinutes));
  const [notice, setNotice] = useState(String(initial.minNoticeMinutes));
  const [ahead, setAhead] = useState(String(initial.maxDaysAhead));
  const [saving, setSaving] = useState(false);

  const allWindowsValid = BOOKING_WEEKDAYS.every((d) => (hours[d] ?? []).every(windowValid));
  const numbersValid =
    Number(grid) >= 5 && Number(grid) <= 240 &&
    Number(notice) >= 0 && Number(notice) <= 10080 &&
    Number(ahead) >= 1 && Number(ahead) <= 365;

  const dirty = useMemo(
    () =>
      mode !== saved.mode ||
      timeZone.trim() !== saved.timeZone ||
      JSON.stringify(cloneHours(hours)) !== JSON.stringify(cloneHours(saved.weeklyHours)) ||
      Number(grid) !== saved.slotIntervalMinutes ||
      Number(notice) !== saved.minNoticeMinutes ||
      Number(ahead) !== saved.maxDaysAhead,
    [mode, timeZone, hours, grid, notice, ahead, saved],
  );

  function setWindow(day: BookingWeekday, index: number, patch: Partial<OpeningWindow>) {
    setHours((prev) => {
      const next = cloneHours(prev);
      const list = next[day] ?? [];
      list[index] = { ...list[index], ...patch };
      next[day] = list;
      return next;
    });
  }
  function addWindow(day: BookingWeekday) {
    setHours((prev) => {
      const next = cloneHours(prev);
      const list = next[day] ?? [];
      const last = list[list.length - 1];
      list.push(last ? { open: last.close, close: last.close < "21:00" ? "21:00" : "23:00" } : { open: "09:00", close: "17:00" });
      next[day] = list;
      return next;
    });
  }
  function removeWindow(day: BookingWeekday, index: number) {
    setHours((prev) => {
      const next = cloneHours(prev);
      const list = (next[day] ?? []).filter((_, i) => i !== index);
      if (list.length) next[day] = list;
      else delete next[day];
      return next;
    });
  }

  async function save() {
    if (!dirty || !allWindowsValid || !numbersValid || saving) return;
    setSaving(true);
    try {
      const next = await updateBookingSettings({
        mode,
        timeZone: timeZone.trim(),
        weeklyHours: cloneHours(hours),
        slotIntervalMinutes: Number(grid),
        minNoticeMinutes: Number(notice),
        maxDaysAhead: Number(ahead),
      });
      setSaved(next);
      setHours(cloneHours(next.weeklyHours));
      toast.success(t.bookings.settings.saved);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.bookings.settings.couldNotSave));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
      {!canEdit ? (
        <p className="mb-6 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          {t.bookings.settings.adminOnly}
        </p>
      ) : null}
      <fieldset disabled={!canEdit} className="space-y-8">
        <div className="space-y-2">
          <p className="text-sm font-medium">{t.bookings.settings.modeLabel}</p>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {BOOKING_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-lg border p-3 text-start transition-colors",
                  mode === m ? "border-lime-ring bg-lime-soft/60" : "border-border hover:bg-secondary",
                )}
              >
                <span className="block text-sm font-medium">{t.bookings.modes[m]}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t.bookings.modeDescriptions[m]}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t.bookings.settings.modeHint}</p>
        </div>

        <div className="space-y-2">
          <label htmlFor="booking-tz" className="text-sm font-medium">
            {t.bookings.settings.timeZoneLabel}
          </label>
          <Input
            id="booking-tz"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="max-w-xs font-mono"
            dir="ltr"
            list="booking-tz-options"
          />
          <datalist id="booking-tz-options">
            {["Asia/Riyadh", "Asia/Dubai", "Asia/Kuwait", "Asia/Qatar", "Asia/Bahrain", "Asia/Muscat", "Africa/Cairo", "Asia/Amman", "Asia/Dhaka", "Europe/London"].map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">{t.bookings.settings.timeZoneHint}</p>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">{t.bookings.settings.hoursLabel}</p>
            <p className="text-xs text-muted-foreground">{t.bookings.settings.hoursHint}</p>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border">
            {BOOKING_WEEKDAYS.map((day) => {
              const windows = hours[day] ?? [];
              return (
                <div key={day} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <span className="w-28 shrink-0 text-sm">{t.bookings.weekdays[day]}</span>
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    {windows.length === 0 ? (
                      <span className="text-sm text-muted-foreground">{t.bookings.settings.closed}</span>
                    ) : (
                      windows.map((w, i) => (
                        <div key={i} className="flex items-center gap-1" dir="ltr">
                          <Input
                            type="time"
                            value={w.open}
                            onChange={(e) => setWindow(day, i, { open: e.target.value })}
                            aria-invalid={!windowValid(w)}
                            className="w-28"
                          />
                          <span className="text-muted-foreground">–</span>
                          <Input
                            type="time"
                            value={w.close}
                            onChange={(e) => setWindow(day, i, { close: e.target.value })}
                            aria-invalid={!windowValid(w)}
                            className="w-28"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => removeWindow(day, i)}
                            aria-label={t.bookings.settings.removeWindow}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))
                    )}
                    {windows.length < MAX_WINDOWS ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => addWindow(day)}>
                        <Plus className="size-4" />
                        {t.bookings.settings.addWindow}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { id: "grid", label: t.bookings.settings.gridLabel, value: grid, set: setGrid, unit: t.bookings.settings.minutes },
            { id: "notice", label: t.bookings.settings.noticeLabel, value: notice, set: setNotice, unit: t.bookings.settings.minutes },
            { id: "ahead", label: t.bookings.settings.aheadLabel, value: ahead, set: setAhead, unit: t.bookings.settings.days },
          ].map((f) => (
            <div key={f.id} className="space-y-1.5">
              <label htmlFor={`booking-${f.id}`} className="text-sm font-medium">
                {f.label}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={`booking-${f.id}`}
                  type="number"
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  className="w-24"
                />
                <span className="text-sm text-muted-foreground">{f.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {canEdit ? (
        <div className="mt-6 flex items-center gap-3 border-t border-border pt-5">
          <Button onClick={save} disabled={!dirty || !allWindowsValid || !numbersValid || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t.bookings.settings.save}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
