// Clarly 2.0 S2: which appointment start times are free on one day. PURE —
// no clock, no database, no calendar API — so every rule below is unit-tested
// with fixed inputs (booking-slots.spec.ts).
//
// One schedule per workspace in this version: overlapping appointments are
// never offered, whatever the service. Multi-staff capacity is deliberately
// out of scope (docs/v2/BUILD_LOG.md S2), because "two at once" is only
// correct when the business really has two people, and the console has no
// way yet to say who does what.
import {
  BOOKING_WEEKDAYS,
  type BookingWeekday,
  type WeeklyHours,
} from '../persistence/drizzle/schema';
import {
  formatClock,
  formatLocalDate,
  parseClock,
  weekdayIndex,
  zonedWallTimeToInstant,
  type LocalDate,
} from './booking-time';

export {
  BOOKING_WEEKDAYS,
  type BookingWeekday,
  type OpeningWindow,
  type WeeklyHours,
} from '../persistence/drizzle/schema';

/** A half-open instant interval [startMs, endMs). */
export interface Interval {
  startMs: number;
  endMs: number;
}

export interface SlotRules {
  timeZone: string;
  weeklyHours: WeeklyHours;
  /** Length of the appointment. */
  durationMinutes: number;
  /** Time kept free after each appointment (cleaning, travel). Applies to existing bookings and to the candidate. */
  bufferMinutes: number;
  /** Start times are offered on this grid from each window's opening time. */
  slotIntervalMinutes: number;
  /** Nothing starting sooner than this after `nowMs` is offered. */
  minNoticeMinutes: number;
}

export interface Slot {
  startMs: number;
  endMs: number;
  /** `HH:MM` in the tenant's zone, for the model and the console. */
  localTime: string;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** Valid windows of one weekday, sorted, as minutes since midnight. */
export function windowsFor(
  hours: WeeklyHours,
  weekday: BookingWeekday,
): Array<{ open: number; close: number }> {
  const out: Array<{ open: number; close: number }> = [];
  for (const w of hours[weekday] ?? []) {
    const open = parseClock(w.open);
    const close = parseClock(w.close);
    // Same rule as business-hours.ts: an inverted window is closed, never
    // guessed into an overnight shift.
    if (open === null || close === null || close <= open) continue;
    out.push({ open, close });
  }
  return out.sort((a, b) => a.open - b.open);
}

/**
 * Every free start time on `date` (the tenant's local calendar date).
 *
 * `blocked` are intervals that must not overlap the candidate, already
 * including any buffer the caller owes them: existing bookings as
 * [start, end + their buffer), and calendar busy blocks as they come.
 */
export function availableSlots(
  date: LocalDate,
  rules: SlotRules,
  blocked: readonly Interval[],
  nowMs: number,
): Slot[] {
  if (rules.durationMinutes <= 0 || rules.slotIntervalMinutes <= 0) return [];
  const weekday = BOOKING_WEEKDAYS[weekdayIndex(date)];
  const earliestMs = nowMs + rules.minNoticeMinutes * 60_000;
  const slots: Slot[] = [];
  const seen = new Set<number>();

  for (const window of windowsFor(rules.weeklyHours, weekday)) {
    for (
      let start = window.open;
      start + rules.durationMinutes <= window.close;
      start += rules.slotIntervalMinutes
    ) {
      const startMs = zonedWallTimeToInstant(date, start, rules.timeZone);
      if (startMs === null || startMs < earliestMs || seen.has(startMs)) {
        continue;
      }
      const endMs = startMs + rules.durationMinutes * 60_000;
      const occupied: Interval = {
        startMs,
        endMs: endMs + rules.bufferMinutes * 60_000,
      };
      if (blocked.some((b) => overlaps(occupied, b))) continue;
      seen.add(startMs);
      slots.push({ startMs, endMs, localTime: formatClock(start) });
    }
  }
  return slots.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Whether one specific local start time on `date` is bookable under `rules`:
 * inside a window, on the grid, with enough notice, and free. Returns the
 * slot, or the reason it is not — the executor turns the reason into what the
 * model tells the customer.
 */
export function checkSlot(
  date: LocalDate,
  startMinutes: number,
  rules: SlotRules,
  blocked: readonly Interval[],
  nowMs: number,
):
  | { ok: true; slot: Slot }
  | { ok: false; reason: 'closed' | 'too_soon' | 'taken' | 'invalid_time' } {
  const weekday = BOOKING_WEEKDAYS[weekdayIndex(date)];
  const window = windowsFor(rules.weeklyHours, weekday).find(
    (w) =>
      startMinutes >= w.open && startMinutes + rules.durationMinutes <= w.close,
  );
  if (!window) return { ok: false, reason: 'closed' };
  if ((startMinutes - window.open) % rules.slotIntervalMinutes !== 0) {
    return { ok: false, reason: 'invalid_time' };
  }
  const startMs = zonedWallTimeToInstant(date, startMinutes, rules.timeZone);
  if (startMs === null) return { ok: false, reason: 'invalid_time' };
  if (startMs < nowMs + rules.minNoticeMinutes * 60_000) {
    return { ok: false, reason: 'too_soon' };
  }
  const endMs = startMs + rules.durationMinutes * 60_000;
  const occupied: Interval = {
    startMs,
    endMs: endMs + rules.bufferMinutes * 60_000,
  };
  if (blocked.some((b) => overlaps(occupied, b))) {
    return { ok: false, reason: 'taken' };
  }
  return {
    ok: true,
    slot: { startMs, endMs, localTime: formatClock(startMinutes) },
  };
}

/** For logs and errors. */
export function describeDate(date: LocalDate): string {
  return formatLocalDate(date);
}
