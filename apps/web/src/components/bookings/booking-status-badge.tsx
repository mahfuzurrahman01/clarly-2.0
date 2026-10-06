"use client";

import { CheckCircle2, CircleSlash, Clock, UserX, BadgeCheck } from "lucide-react";
import type { BookingStatus } from "@/lib/api/bookings";
import { useTranslations } from "@/lib/i18n/provider";

/** Colour AND icon AND word, like the order badges — colour alone is not a signal everyone gets. */
const base =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap";

const STYLES: Record<BookingStatus, string> = {
  requested: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  confirmed: "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
  completed: "border-border bg-secondary text-foreground",
  cancelled: "border-border bg-secondary text-muted-foreground",
  no_show: "border-destructive/40 bg-destructive/5 text-destructive",
};

const ICONS: Record<BookingStatus, typeof Clock> = {
  requested: Clock,
  confirmed: CheckCircle2,
  completed: BadgeCheck,
  cancelled: CircleSlash,
  no_show: UserX,
};

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const t = useTranslations();
  const Icon = ICONS[status];
  return (
    <span className={`${base} ${STYLES[status]}`}>
      <Icon className="size-3" aria-hidden="true" />
      {t.bookings.status[status]}
    </span>
  );
}
