"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Bell,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  CheckCheck,
  ChevronDown,
  ClipboardList,
  CreditCard,
  Gauge,
  Hourglass,
  type LucideIcon,
  Megaphone,
  OctagonAlert,
  PackageX,
  ShieldAlert,
  ShoppingBag,
  Store,
  TriangleAlert,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import {
  type NotificationKind,
  type NotificationRecord,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/api/notifications";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations, useLocale } from "@/lib/i18n/provider";
import { relativeAgo } from "@/lib/i18n/relative-time";
import { cn } from "@/lib/utils";
import { now } from "@/lib/time";
import {
  isKnownKind,
  localiseNotification,
  notificationHref,
  notificationSeverity,
} from "./notification-copy";

const POLL_MS = 30_000;

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  ticket_stuck: Hourglass,
  latency_budget_exceeded: Gauge,
  tool_scope_violations: ShieldAlert,
  trial_ending: CalendarClock,
  trial_expired: CalendarX,
  payment_failed: CreditCard,
  campaign_paused: Megaphone,
  order_pending_approval: ShoppingBag,
  order_store_push_failed: Store,
  order_auto_mode_review: ClipboardList,
  courier_connection_failing: Truck,
  shipment_template_unusable: PackageX,
  booking_requested: CalendarPlus,
  calendar_needs_reconnect: CalendarX,
};

/** Rows whose lower half sits under the list's visible bottom edge. */
function countRowsBelow(list: HTMLElement): number {
  const visibleBottom = list.scrollTop + list.clientHeight;
  let below = 0;
  for (const row of Array.from(list.children)) {
    if (!(row instanceof HTMLElement)) continue;
    if (row.offsetTop + row.offsetHeight / 2 > visibleBottom) below += 1;
  }
  return below;
}

export function NotificationsBell() {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationRecord[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshCount = useCallback(async () => {
    try {
      const { unread } = await getUnreadCount();
      setUnread(unread);
    } catch {
      // Polling failure isn't worth interrupting the user over.
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(refreshCount, 0);
    const id = setInterval(refreshCount, POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [refreshCount]);

  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && items === null) {
      setLoading(true);
      try {
        setItems(await listNotifications({ limit: 50 }));
      } catch {
        toast.error(t.notifications.couldNotLoad);
        setItems([]);
      } finally {
        setLoading(false);
      }
    }
  }

  async function onItemClick(n: NotificationRecord) {
    if (!n.readAt) {
      setItems((prev) =>
        prev
          ? prev.map((it) => (it.id === n.id ? { ...it, readAt: new Date().toISOString() } : it))
          : prev,
      );
      setUnread((count) => Math.max(0, count - 1));
      try {
        await markNotificationRead(n.id);
      } catch {
        // Best-effort — a stale unread badge is a minor annoyance, not worth reverting the UI over.
      }
    }
  }

  async function onMarkAllRead() {
    const previous = items;
    setItems((prev) => prev?.map((it) => ({ ...it, readAt: it.readAt ?? new Date().toISOString() })) ?? prev);
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      setItems(previous);
      toast.error(t.notifications.couldNotMarkAll);
      refreshCount();
    }
  }

  // Only ~4 rows fit before the list scrolls; say how many sit below the fold
  // so the rest are not mistaken for "that's all".
  const listRef = useRef<HTMLDivElement>(null);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  const measureList = useCallback(() => {
    const list = listRef.current;
    setHiddenBelow(list ? countRowsBelow(list) : 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(measureList);
    return () => cancelAnimationFrame(frame);
  }, [open, items, loading, measureList]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.notifications.title}
            className="relative"
          />
        }
      >
        <Bell className="size-5" />
        {unread > 0 ? (
          <span className="absolute top-1 end-1 grid size-4 place-items-center rounded-full bg-lime text-[10px] font-medium text-lime-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-sm font-medium">{t.notifications.title}</p>
          {items && items.some((n) => !n.readAt) ? (
            <button
              type="button"
              onClick={onMarkAllRead}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <CheckCheck className="size-3.5" aria-hidden="true" />
              {t.notifications.markAllRead}
            </button>
          ) : null}
        </div>
        <div className="relative">
          <div
            ref={listRef}
            onScroll={measureList}
            className="relative max-h-96 overflow-y-auto overscroll-contain"
          >
            {loading ? (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {t.notifications.loading}
              </p>
            ) : items && items.length > 0 ? (
              items.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onSelect={() => onItemClick(n)}
                />
              ))
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {t.notifications.empty}
              </p>
            )}
          </div>
          {hiddenBelow > 0 ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-end justify-center bg-linear-to-t from-popover from-35% to-transparent pb-1.5"
            >
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <ChevronDown className="size-3.5" />
                {t.notifications.moreBelowTemplate.replace(
                  "{count}",
                  new Intl.NumberFormat(locale).format(hiddenBelow),
                )}
              </span>
            </div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ROW_CLASS = "block border-b border-border last:border-b-0";

function NotificationRow({
  notification: n,
  onSelect,
}: {
  notification: NotificationRecord;
  onSelect: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const critical = notificationSeverity(n) === "critical";
  // The kind's own icon; a kind the console doesn't know yet gets the generic severity shape.
  const Icon = isKnownKind(n.kind)
    ? KIND_ICON[n.kind]
    : critical
      ? OctagonAlert
      : TriangleAlert;
  const { title, body } = localiseNotification(n, t, locale);
  const href = notificationHref(n);

  const content = (
    <div
      className={cn(
        "flex gap-2.5 px-3 py-2.5 text-start transition-colors hover:bg-secondary/60",
        !n.readAt && "bg-lime-soft/30",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          critical ? "text-destructive" : "text-amber-500",
        )}
      />
      {/* Kept outside the title so its script never decides the title's direction. */}
      <span className="sr-only">
        {critical ? t.notifications.severityCritical : t.notifications.severityWarning}
      </span>
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-start text-sm font-medium">
          {title}
        </p>
        <p dir="auto" className="mt-0.5 line-clamp-2 text-start text-xs text-muted-foreground">
          {body}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          <time dateTime={n.createdAt}>{relativeAgo(n.createdAt, locale, now())}</time>
        </p>
      </div>
      {!n.readAt ? (
        <span className="mt-1 size-2 shrink-0 rounded-full bg-lime">
          <span className="sr-only">{t.notifications.unread}</span>
        </span>
      ) : null}
    </div>
  );

  return href ? (
    <Link href={href} onClick={onSelect} className={ROW_CLASS}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onSelect} className={cn(ROW_CLASS, "w-full")}>
      {content}
    </button>
  );
}
