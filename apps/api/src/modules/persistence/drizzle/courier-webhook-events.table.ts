// F26 (Delivery Tracking): idempotency log for courier push callbacks (D6).
//
// No RLS, deliberately: the row is claimed BEFORE the tenant is known, from
// the (courier, account_ref) routing key alone — the same documented
// pre-tenant carve-out as `store_webhook_events` and `social_channels`. That
// is also why nothing in a callback body is ever allowed to choose a tenant.
//
// The (courier, account_ref, event_id) unique constraint is the claim. J&T
// retries aggressively; a replayed body must be a no-op, not a second status
// application and certainly not a second billed template.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  unique,
  index,
} from 'drizzle-orm/pg-core';

export const COURIER_WEBHOOK_EVENT_STATUSES = [
  'received',
  'processed',
  'failed',
  'ignored',
] as const;
export type CourierWebhookEventStatus =
  (typeof COURIER_WEBHOOK_EVENT_STATUSES)[number];

export const courierWebhookEvents = pgTable(
  'courier_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courier: text('courier').notNull(),
    accountRef: text('account_ref').notNull(),
    /** The courier's own event id, or SHA-256 of the raw body when it gives us nothing stable. */
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status').notNull().default('received'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.courier, table.accountRef, table.eventId),
    index('courier_webhook_events_courier_account_idx').on(
      table.courier,
      table.accountRef,
    ),
  ],
);
