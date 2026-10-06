// F11: where a tenant's own system receives what the agent collected.
//
// The data has been structured since F10 and has had nowhere to go. This is
// the egress: a tenant registers a URL, we sign and POST events to it.
//
// The secret is stored encrypted with the same service the BSP credentials
// use — it is the only thing standing between a signed webhook and anyone who
// can guess a payload shape.
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/** What a tenant can subscribe to. Deliberately small: each one is a promise about payload shape we then have to keep. */
export const WEBHOOK_EVENTS = [
  'conversation.intake_captured',
  'ticket.created',
  'ticket.resolved',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const tenantWebhooks = pgTable('tenant_webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  /** AES-256-GCM ciphertext, never returned by any read path — a tenant sees it once, at creation. */
  secretEncrypted: text('secret_encrypted').notNull(),
  events: jsonb('events').notNull().default('[]').$type<WebhookEvent[]>(),
  enabled: boolean('enabled').notNull().default(true),
  /** Set when deliveries keep failing, so a tenant can see their endpoint is broken without reading our logs. */
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastFailureReason: text('last_failure_reason'),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
