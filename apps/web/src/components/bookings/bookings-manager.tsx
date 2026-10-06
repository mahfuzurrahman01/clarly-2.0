"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarCheck,
  Check,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  UserX,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import {
  BOOKINGS_PAGE_SIZE,
  cancelBooking,
  completeBooking,
  confirmBooking,
  listBookings,
  markBookingNoShow,
  type Booking,
  type BookingMode,
  type BookingPage,
  type BookingServiceItem,
  type ListBookingsParams,
} from "@/lib/api/bookings";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookingStatusBadge } from "./booking-status-badge";
import { CancelBookingDialog } from "./cancel-booking-dialog";
import { NewBookingDialog } from "./new-booking-dialog";
import {
  dayKey,
  formatBookingDay,
  formatBookingTime,
  minutesBetween,
  todayIn,
} from "./format";

type Tab = "upcoming" | "requests" | "past" | "cancelled";

const ACTIVE = new Set(["requested", "confirmed"]);

/** Which API query each tab is, and which rows it keeps. */
function queryFor(tab: Tab, nowIso: string): { params: ListBookingsParams; keep: (b: Booking) => boolean } {
  switch (tab) {
    case "upcoming":
      return { params: { from: nowIso, order: "asc" }, keep: (b) => ACTIVE.has(b.status) };
    case "requests":
      return { params: { status: "requested", order: "asc" }, keep: () => true };
    case "past":
      return { params: { to: nowIso, order: "desc" }, keep: (b) => b.status !== "cancelled" };
    case "cancelled":
      return { params: { status: "cancelled", order: "desc" }, keep: () => true };
  }
}

export function BookingsManager({
  initial,
  initialRequestCount,
  services,
  mode,
  timeZone,
  now,
}: {
  /** The upcoming tab, server-rendered. */
  initial: BookingPage;
  initialRequestCount: number;
  services: BookingServiceItem[];
  mode: BookingMode;
  timeZone: string;
  now: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [tab, setTab] = useState<Tab>("upcoming");
  const [items, setItems] = useState<Booking[]>(initial.items.filter((b) => ACTIVE.has(b.status)));
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const [creating, setCreating] = useState(false);
  const [requestCount, setRequestCount] = useState(initialRequestCount);
  const nowIso = useMemo(() => new Date(now).toISOString(), [now]);

  const load = useCallback(
    async (which: Tab, cursor?: string) => {
      const { params, keep } = queryFor(which, nowIso);
      setLoading(true);
      try {
        const page = await listBookings({ ...params, cursor, limit: BOOKINGS_PAGE_SIZE });
        const rows = page.items.filter(keep);
        setItems((prev) => (cursor ? [...prev, ...rows] : rows));
        setNextCursor(page.nextCursor);
        setLoadError(null);
        if (which === "requests" && !cursor) setRequestCount(rows.length);
      } catch (err) {
        setLoadError(apiErrorMessage(err, t, t.bookings.errorBody));
      } finally {
        setLoading(false);
      }
    },
    [nowIso, t],
  );

  function changeTab(next: Tab) {
    setTab(next);
    void load(next);
  }

  function replace(updated: Booking) {
    const { keep } = queryFor(tab, nowIso);
    setItems((prev) =>
      keep(updated)
        ? prev.map((b) => (b.id === updated.id ? updated : b))
        : prev.filter((b) => b.id !== updated.id),
    );
  }

  async function act(booking: Booking, run: () => Promise<Booking>, success: string) {
    setPending(booking.id);
    try {
      const updated = await run();
      replace(updated);
      if (booking.status === "requested" && updated.status !== "requested") {
        setRequestCount((c) => Math.max(0, c - 1));
      }
      toast.success(success);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.message(t.bookings.toasts.alreadyHandled);
        void load(tab);
      } else {
        toast.error(apiErrorMessage(err, t, t.bookings.toasts.failed));
      }
      return false;
    } finally {
      setPending(null);
    }
  }

  const groups = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of items) {
      const key = dayKey(b.startsAt, b.timeZone);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return [...map.entries()];
  }, [items]);

  const today = todayIn(timeZone, now);

  return (
    <div className="space-y-6">
      {mode === "disabled" ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t.bookings.disabledNotice}{" "}
          <Link href="/settings/bookings" className="text-lime-text underline">
            {t.bookings.settingsLink}
          </Link>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => changeTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="upcoming">{t.bookings.tabs.upcoming}</TabsTrigger>
            <TabsTrigger value="requests">
              {t.bookings.tabs.requests}
              {requestCount > 0 ? (
                <span className="ms-1.5 rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-700 tabular-nums dark:text-amber-400">
                  {requestCount}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="past">{t.bookings.tabs.past}</TabsTrigger>
            <TabsTrigger value="cancelled">{t.bookings.tabs.cancelled}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load(tab)} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t.bookings.actions.refresh}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t.bookings.actions.newBooking}
          </Button>
        </div>
      </div>

      {loadError ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : null}

      {items.length === 0 && !loading ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-14 text-center">
          <CalendarCheck className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t.bookings.empty[tab]}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([key, rows]) => (
            <section key={key} className="space-y-2">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {key === today ? `${t.bookings.when.today} · ` : ""}
                {formatBookingDay(rows[0].startsAt, rows[0].timeZone, locale)}
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/60">
                {rows.map((b) => {
                  const busy = pending === b.id;
                  const started = Date.parse(b.startsAt) <= now;
                  return (
                    <li key={b.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-4">
                        <div className="w-14 shrink-0 font-mono text-sm tabular-nums" dir="ltr">
                          {formatBookingTime(b.startsAt, b.timeZone, locale)}
                          <div className="text-xs text-muted-foreground">
                            {t.bookings.when.minutes.replace("{n}", String(minutesBetween(b.startsAt, b.endsAt)))}
                          </div>
                        </div>
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium">{b.customerName}</span>
                            <BookingStatusBadge status={b.status} />
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {b.serviceName} · {t.bookings.location[b.location]} · {t.bookings.source[b.source]}
                            <span className="ms-2 font-mono text-xs" dir="ltr">{b.reference}</span>
                          </p>
                          {b.customerPhone || b.customerEmail ? (
                            <p className="text-xs text-muted-foreground" dir="ltr">
                              {[b.customerPhone, b.customerEmail].filter(Boolean).join(" · ")}
                            </p>
                          ) : null}
                          {b.notes ? <p className="text-xs text-muted-foreground">{b.notes}</p> : null}
                          {b.calendarSyncStatus === "failed" ? (
                            <p className="text-xs text-destructive">{t.bookings.calendarSync.failed}</p>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                        {b.meetingUrl ? (
                          <Button variant="ghost" size="sm" render={<a href={b.meetingUrl} target="_blank" rel="noreferrer" />}>
                            <Video className="size-4" />
                            {t.bookings.actions.joinMeeting}
                          </Button>
                        ) : null}
                        {b.conversationId ? (
                          <Button variant="ghost" size="sm" render={<Link href={`/inbox/${b.conversationId}`} />}>
                            <MessageSquare className="size-4" />
                            {t.bookings.actions.openChat}
                          </Button>
                        ) : null}
                        {b.status === "requested" ? (
                          <Button size="sm" disabled={busy} onClick={() => void act(b, () => confirmBooking(b.id), t.bookings.toasts.confirmed)}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                            {t.bookings.actions.confirm}
                          </Button>
                        ) : null}
                        {b.status === "confirmed" && started ? (
                          <>
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(b, () => completeBooking(b.id), t.bookings.toasts.completed)}>
                              <CalendarCheck className="size-4" />
                              {t.bookings.actions.complete}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(b, () => markBookingNoShow(b.id), t.bookings.toasts.noShow)}>
                              <UserX className="size-4" />
                              {t.bookings.actions.noShow}
                            </Button>
                          </>
                        ) : null}
                        {ACTIVE.has(b.status) ? (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(b)}>
                            <X className="size-4" />
                            {t.bookings.actions.cancel}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void load(tab, nextCursor)} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {t.bookings.actions.loadMore}
          </Button>
        </div>
      ) : null}

      <CancelBookingDialog
        booking={cancelling}
        submitting={cancelling !== null && pending === cancelling.id}
        onOpenChange={(open) => (open ? null : setCancelling(null))}
        onConfirm={(b, reason) => act(b, () => cancelBooking(b.id, reason || undefined), t.bookings.toasts.cancelled)}
      />

      <NewBookingDialog
        open={creating}
        onOpenChange={setCreating}
        services={services}
        defaultDate={today}
        onCreated={(b) => {
          toast.success(t.bookings.toasts.created);
          if (queryFor(tab, nowIso).keep(b)) {
            setItems((prev) => [...prev, b].sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt)));
          }
        }}
      />
    </div>
  );
}
