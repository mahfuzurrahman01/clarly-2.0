import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const BOOKING_LOCATIONS = ['in_person', 'online', 'phone'] as const;
export type BookingLocation = (typeof BOOKING_LOCATIONS)[number];

/** Clarly 2.0 S2 (migration 0071): something a customer can book. */
export const bookingServices = pgTable(
  'booking_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    durationMinutes: integer('duration_minutes').notNull(),
    /** Time kept free after each appointment of this service. */
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    /** Null = price on request; the agent never invents one. */
    price: numeric('price', { precision: 12, scale: 2 }),
    currency: text('currency'),
    location: text('location')
      .$type<BookingLocation>()
      .notNull()
      .default('in_person'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('booking_services_tenant_id_id_unique').on(table.tenantId, table.id),
  ],
).enableRLS();
