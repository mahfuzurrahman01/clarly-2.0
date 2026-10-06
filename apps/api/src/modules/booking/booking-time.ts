// Clarly 2.0 S2 (bookings): wall-clock <-> instant conversion in a tenant's
// IANA time zone, without a date library.
//
// Autologic computed booking times by asking the model for ISO strings
// "in the Asia/Dhaka timezone" (docs/v2/AUTOLOGIC_AUDIT.md #17). Here the model
// never does date arithmetic: it says "2026-10-08 at 15:30", and this file
// turns that into an instant for the tenant's own zone, DST included.
//
// Same choice as agent-config/business-hours.ts: Intl answers "what is the
// local wall time of this instant in zone Z" correctly, and that is the only
// primitive needed. The inverse is solved by the standard two-pass offset
// correction below.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

export interface LocalDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

/** Parses `YYYY-MM-DD` into a real calendar date, or null (Feb 30 is null). */
export function parseLocalDate(value: string): LocalDate | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function formatLocalDate(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** `HH:MM` → minutes since midnight, or null. 24:00 is not a clock time. */
export function parseClock(value: string): number | null {
  const m = CLOCK_RE.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday, for a calendar date (zone-independent). */
export function weekdayIndex(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** True when `timeZone` is a zone this runtime's Intl knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

interface WallTime extends LocalDate {
  minutes: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** The wall-clock date and time of `instantMs` in `timeZone`. */
export function wallTimeOf(instantMs: number, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    minutes: (get('hour') % 24) * 60 + get('minute'),
  };
}

/** Milliseconds the zone is ahead of UTC at `instantMs` (whole minutes). */
function offsetMs(instantMs: number, timeZone: string): number {
  const w = wallTimeOf(instantMs, timeZone);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    Math.floor(w.minutes / 60),
    w.minutes % 60,
  );
  const truncated = instantMs - (((instantMs % 60_000) + 60_000) % 60_000);
  return asUtc - truncated;
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` + `minutes`,
 * or null when that wall time does not exist (the hour skipped by a DST
 * spring-forward). An ambiguous fall-back time resolves to its first
 * occurrence. Never throws for a valid zone.
 */
export function zonedWallTimeToInstant(
  date: LocalDate,
  minutes: number,
  timeZone: string,
): number | null {
  const naive = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Math.floor(minutes / 60),
    minutes % 60,
  );
  let guess = naive - offsetMs(naive, timeZone);
  const second = naive - offsetMs(guess, timeZone);
  if (second !== guess) guess = Math.min(guess, second);

  const check = wallTimeOf(guess, timeZone);
  if (
    check.year !== date.year ||
    check.month !== date.month ||
    check.day !== date.day ||
    check.minutes !== minutes
  ) {
    return null;
  }
  return guess;
}

/** Today's calendar date in `timeZone`. */
export function localToday(nowMs: number, timeZone: string): LocalDate {
  const w = wallTimeOf(nowMs, timeZone);
  return { year: w.year, month: w.month, day: w.day };
}
