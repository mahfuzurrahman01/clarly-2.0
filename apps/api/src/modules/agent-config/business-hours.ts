// F9 / SAAS_READINESS §8: when a tenant is actually open.
//
// Two things depend on this, and they are not the same thing:
//   - what the agent TELLS a customer who writes at 3am, and
//   - whether a ticket created at 3am is "stuck" by 3:20am.
//
// The second is the operational bug. The stuck-ticket sweep measures
// wall-clock minutes, so an escalation at 3am is overdue before anyone could
// possibly have claimed it — which inflates the stuck metric, fires
// notifications nobody can act on, and teaches a tenant to ignore both.
//
// Timezones are handled with Intl rather than a date library: the only
// question asked here is "what is the local weekday and clock time in this
// IANA zone", which `Intl.DateTimeFormat` answers correctly including DST,
// and pulling in a dependency for it would be more code to trust, not less.

/** Local clock times, `HH:MM`, in the tenant's own timezone. A day with no entry is closed. */
export interface DayHours {
  open: string;
  close: string;
}

export const WEEKDAYS = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type BusinessHours = Partial<Record<Weekday, DayHours>>;

interface LocalMoment {
  weekday: Weekday;
  /** Minutes since local midnight. */
  minutes: number;
}

function localMoment(at: Date, timezone: string): LocalMoment | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    // An unknown IANA zone must not take down the sweep that called this.
    // Treating it as "no hours configured" degrades to the previous
    // wall-clock behaviour rather than to silence.
    return null;
  }

  const lookup = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = lookup('weekday').slice(0, 3).toLowerCase() as Weekday;
  if (!WEEKDAYS.includes(weekday)) return null;

  const hour = Number(lookup('hour'));
  const minute = Number(lookup('minute'));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  // Intl renders midnight as 24 in some locales/zones under hour12:false.
  return { weekday, minutes: (hour % 24) * 60 + minute };
}

function toMinutes(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Whether the tenant is open at `at`.
 *
 * No hours configured means always open — the behaviour every tenant had
 * before this existed, and the only safe reading of "they have not told us
 * yet".
 *
 * A day whose `close` is at or before its `open` (an overnight shift, or a
 * typo) is treated as closed rather than guessed at: silently interpreting
 * 22:00-06:00 as an overnight window would make a tenant who meant
 * 06:00-22:00 look open all night.
 */
export function isOpenAt(
  hours: BusinessHours | null,
  timezone: string | null,
  at: Date,
): boolean {
  if (!hours || Object.keys(hours).length === 0 || !timezone) return true;

  const moment = localMoment(at, timezone);
  if (!moment) return true;

  const day = hours[moment.weekday];
  if (!day) return false;

  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  if (open === null || close === null || close <= open) return false;

  return moment.minutes >= open && moment.minutes < close;
}

/** Minutes of the day this tenant is open, indexed by weekday — the per-day budget the accrual below spends. */
function openMinutesByDay(hours: BusinessHours): Map<Weekday, number> {
  const budget = new Map<Weekday, number>();
  for (const weekday of WEEKDAYS) {
    const day = hours[weekday];
    if (!day) continue;
    const open = toMinutes(day.open);
    const close = toMinutes(day.close);
    if (open === null || close === null || close <= open) continue;
    budget.set(weekday, close - open);
  }
  return budget;
}

/**
 * How many OPEN minutes elapsed between two instants.
 *
 * This is what the stuck-ticket sweep should measure instead of wall-clock:
 * a ticket that arrives ten minutes before closing and is claimed ten minutes
 * after opening waited twenty business minutes, not fourteen hours.
 *
 * Walks in one-minute steps, bounded to a week. Cheap enough for a sweep that
 * runs on a timer over open tickets, and the bound stops a ticket left over a
 * long holiday from turning a metric query into a loop over months.
 */
export function businessMinutesBetween(
  hours: BusinessHours | null,
  timezone: string | null,
  from: Date,
  to: Date,
): number {
  if (!hours || Object.keys(hours).length === 0 || !timezone) {
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
  }

  const budget = openMinutesByDay(hours);
  // A tenant with hours configured but every day closed would otherwise never
  // accrue a minute, so a genuinely stuck ticket could never be flagged.
  if (budget.size === 0) {
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
  }

  const WEEK_MINUTES = 7 * 24 * 60;
  const totalMinutes = Math.floor((to.getTime() - from.getTime()) / 60_000);
  if (totalMinutes <= 0) return 0;

  let open = 0;
  for (let step = 0; step < Math.min(totalMinutes, WEEK_MINUTES); step += 1) {
    const at = new Date(from.getTime() + step * 60_000);
    if (isOpenAt(hours, timezone, at)) open += 1;
  }
  return open;
}

/** One line for the prompt, so the agent can set an honest expectation instead of implying someone is reading right now. */
export function describeNextOpening(
  hours: BusinessHours | null,
  timezone: string | null,
): string | null {
  if (!hours || Object.keys(hours).length === 0 || !timezone) return null;

  const days = WEEKDAYS.filter((weekday) => hours[weekday]).map((weekday) => {
    const day = hours[weekday] as DayHours;
    return `${weekday} ${day.open}-${day.close}`;
  });

  return days.length > 0 ? `${days.join(', ')} (${timezone})` : null;
}
