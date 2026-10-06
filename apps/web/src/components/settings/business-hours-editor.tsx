"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import type { BusinessHours, DayHours, Weekday } from "@/lib/api/agents";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { useTranslations } from "@/lib/i18n/provider";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function weekdayLabels(t: Dictionary): Record<Weekday, string> {
  return {
    sun: t.settings.weekdaySun,
    mon: t.settings.weekdayMon,
    tue: t.settings.weekdayTue,
    wed: t.settings.weekdayWed,
    thu: t.settings.weekdayThu,
    fri: t.settings.weekdayFri,
    sat: t.settings.weekdaySat,
  };
}

const WEEKDAY_ORDER: Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/**
 * Native time inputs size their segments to the browser's 12/24-hour locale.
 * A fixed narrow width clipped the AM/PM segment, so "17:00" read as "05:00".
 * `w-auto` lets the control take its intrinsic width, and `dir="ltr"` keeps
 * the hour, minute and meridiem segments in reading order inside the RTL UI.
 */
const TIME_INPUT = "h-8 w-auto min-w-[7.5rem] text-xs tabular-nums";

type BusinessHoursEditorProps = {
  value: BusinessHours | null;
  onChange: (value: BusinessHours | null) => void;
  timezone?: string | null;
  className?: string;
};

/**
 * A compact weekly schedule editor for business hours.
 * Each day has an open/close time pair, or can be toggled off (closed).
 */
export function BusinessHoursEditor({
  value,
  onChange,
  timezone,
  className,
}: BusinessHoursEditorProps) {
  const t = useTranslations();
  const labels = weekdayLabels(t);
  const [hours, setHours] = useState<BusinessHours>(value ?? {});

  function updateDay(weekday: Weekday, dayHours: DayHours | null) {
    const next = { ...hours };
    if (dayHours) {
      next[weekday] = dayHours;
    } else {
      delete next[weekday];
    }
    setHours(next);
    onChange(Object.keys(next).length > 0 ? next : null);
  }

  function toggleDay(weekday: Weekday) {
    const existing = hours[weekday];
    if (existing) {
      updateDay(weekday, null);
    } else {
      updateDay(weekday, { open: "09:00", close: "17:00" });
    }
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">{t.settings.businessHoursTitle}</p>
        {timezone ? (
          <span className="text-xs text-muted-foreground">
            (<bdi>{timezone}</bdi>)
          </span>
        ) : null}
      </div>

      <div className="space-y-2">
        {WEEKDAY_ORDER.map((weekday) => {
          const day = hours[weekday];
          const isOpen = !!day;
          const dayLabel = labels[weekday];

          return (
            <div
              key={weekday}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
            >
              <button
                type="button"
                onClick={() => toggleDay(weekday)}
                aria-pressed={isOpen}
                aria-label={t.settings.dayToggleAriaTemplate.replace(
                  "{day}",
                  dayLabel,
                )}
                className={cn(
                  "w-20 shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  isOpen
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {dayLabel}
              </button>

              {isOpen ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    dir="ltr"
                    value={day.open}
                    onChange={(e) =>
                      updateDay(weekday, { ...day, open: e.target.value })
                    }
                    className={TIME_INPUT}
                    aria-label={t.settings.openTimeAriaTemplate.replace(
                      "{day}",
                      dayLabel,
                    )}
                  />
                  <span className="text-xs text-muted-foreground">
                    {t.settings.timeRangeSeparator}
                  </span>
                  <Input
                    type="time"
                    dir="ltr"
                    value={day.close}
                    onChange={(e) =>
                      updateDay(weekday, { ...day, close: e.target.value })
                    }
                    className={TIME_INPUT}
                    aria-label={t.settings.closeTimeAriaTemplate.replace(
                      "{day}",
                      dayLabel,
                    )}
                  />
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t.settings.closed}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {timezone
          ? t.settings.timesInTemplate.replace("{timezone}", timezone)
          : t.settings.setTimezoneHint}
      </p>
    </div>
  );
}
