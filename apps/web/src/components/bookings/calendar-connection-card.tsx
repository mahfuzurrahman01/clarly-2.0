"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Loader2, Unplug } from "lucide-react";
import { toast } from "sonner";
import {
  disconnectCalendar,
  startCalendarConnect,
  type CalendarStatus,
} from "@/lib/api/bookings";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";

/**
 * Google Calendar connect. The API hands back Google's consent URL with a
 * signed one-shot state; Google returns to the API's callback, which redirects
 * here with `?calendar=connected|denied|error|invalid_state`.
 */
export function CalendarConnectionCard({
  initial,
  canEdit,
  result,
}: {
  initial: CalendarStatus;
  canEdit: boolean;
  result: string | null;
}) {
  const t = useTranslations();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!result) return;
    if (result === "connected") toast.success(t.bookings.calendar.resultConnected);
    else if (result === "denied") toast.message(t.bookings.calendar.resultDenied);
    else toast.error(t.bookings.calendar.resultError);
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar");
    window.history.replaceState(null, "", url.toString());
  }, [result, t]);

  async function connect() {
    setBusy(true);
    try {
      const { url } = await startCalendarConnect();
      window.location.assign(url);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.bookings.calendar.couldNotStart));
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectCalendar();
      setStatus({ ...status, connection: null });
      toast.success(t.bookings.calendar.disconnected);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.bookings.toasts.failed));
    } finally {
      setBusy(false);
    }
  }

  const connection = status.connection;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
      <div className="flex items-start gap-3">
        <CalendarDays className="mt-0.5 size-5 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="font-display text-lg font-medium tracking-tight">{t.bookings.calendar.title}</h2>
          <p className="text-sm text-muted-foreground">{t.bookings.calendar.description}</p>
        </div>
      </div>

      {!status.configured ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
          {t.bookings.calendar.notConfigured}
        </p>
      ) : connection ? (
        <div className="space-y-3">
          {connection.status === "needs_reconnect" ? (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {t.bookings.calendar.needsReconnect}
            </p>
          ) : (
            <p className="text-sm">
              {t.bookings.calendar.connected.replace("{account}", connection.accountEmail ?? "Google")}
            </p>
          )}
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              {connection.status === "needs_reconnect" ? (
                <Button size="sm" onClick={connect} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t.bookings.calendar.reconnect}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={disconnect} disabled={busy}>
                <Unplug className="size-4" />
                {t.bookings.calendar.disconnect}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t.bookings.calendar.notConnected}</p>
          {canEdit ? (
            <Button size="sm" onClick={connect} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.bookings.calendar.connect}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
