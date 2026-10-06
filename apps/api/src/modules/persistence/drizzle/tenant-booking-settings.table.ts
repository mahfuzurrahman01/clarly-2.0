import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/**
 * Clarly 2.0 S2 (migration 0071). `disabled` (also: no row at all) means the
 * booking tools are not offered to the agent. `request` records an appointment
 * request a person confirms; `auto` confirms it at once (and writes the
 * calendar event when a calendar is connected).
 */
export const BOOKING_MODES = ['disabled', 'request', 'auto'] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export const BOOKING_WEEKDAYS = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const;
export type BookingWeekday = (typeof BOOKING_WEEKDAYS)[number];

/** Local clock window `HH:MM`–`HH:MM`; `close` after `open` (no overnight windows). */
export interface OpeningWindow {
  open: string;
  close: string;
}

/** Up to a few windows per weekday (a lunch break). A missing or empty day is closed. */
export type WeeklyHours = Partial<Record<BookingWeekday, OpeningWindow[]>>;

export const tenantBookingSettings = pgTable('tenant_booking_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  mode: text('mode').$type<BookingMode>().notNull().default('disabled'),
  /** IANA zone every booking time is read and written in. */
  timeZone: text('time_zone').notNull(),
  weeklyHours: jsonb('weekly_hours').$type<WeeklyHours>().notNull().default({}),
  slotIntervalMinutes: integer('slot_interval_minutes').notNull().default(30),
  minNoticeMinutes: integer('min_notice_minutes').notNull().default(60),
  maxDaysAhead: integer('max_days_ahead').notNull().default(30),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
