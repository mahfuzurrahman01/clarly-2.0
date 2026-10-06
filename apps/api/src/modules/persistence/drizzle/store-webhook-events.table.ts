// Feature 24 (Store Integrations): idempotency log for store webhooks.
// No RLS — webhook events are resolved via store_id lookup before tenant
// context exists (same pattern as social-channels).
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  unique,
  index,
} from 'drizzle-orm/pg-core';

export const WEBHOOK_EVENT_STATUSES = [
  'received',
  'processed',
  'failed',
  'ignored',
] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const storeWebhookEvents = pgTable(
  'store_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    storeId: text('store_id').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}),
    status: text('status').notNull().default('received'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.provider, table.storeId, table.eventId),
    index('store_webhook_events_provider_store_id_idx').on(
      table.provider,
      table.storeId,
    ),
  ],
);
