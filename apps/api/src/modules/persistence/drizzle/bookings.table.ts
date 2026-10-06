import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { conversations } from './conversations.table';
import type { BookingLocation } from './booking-services.table';

export const BOOKING_STATUSES = [
  'requested',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses that hold a slot. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'requested',
  'confirmed',
];

export const BOOKING_SOURCES = ['agent', 'console'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const CALENDAR_SYNC_STATUSES = [
  'not_applicable',
  'pending',
  'synced',
  'failed',
] as const;
export type CalendarSyncStatus = (typeof CALENDAR_SYNC_STATUSES)[number];

/**
 * Clarly 2.0 S2 (migration 0071): the appointment of record. Service name,
 * buffer and time zone are SNAPSHOTS: renaming a service or moving the
 * business's zone must not rewrite what a customer was told.
 *
 * `serviceId` and `customerId` are composite-FK'd with `tenantId` in SQL, so a
 * booking can never point at another tenant's service or customer.
 */
export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reference: text('reference').notNull(),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id'),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<BookingStatus>().notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    timeZone: text('time_zone').notNull(),
    serviceName: text('service_name').notNull(),
    location: text('location').$type<BookingLocation>().notNull(),
    customerName: text('customer_name').notNull(),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    notes: text('notes'),
    meetingUrl: text('meeting_url'),
    calendarEventId: text('calendar_event_id'),
    calendarSyncStatus: text('calendar_sync_status')
      .$type<CalendarSyncStatus>()
      .notNull()
      .default('not_applicable'),
    calendarSyncError: text('calendar_sync_error'),
    source: text('source').$type<BookingSource>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdBy: uuid('created_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('bookings_tenant_id_id_unique').on(table.tenantId, table.id),
    unique('bookings_tenant_reference_unique').on(
      table.tenantId,
      table.reference,
    ),
    unique('bookings_tenant_idempotency_unique').on(
      table.tenantId,
      table.idempotencyKey,
    ),
  ],
).enableRLS();
