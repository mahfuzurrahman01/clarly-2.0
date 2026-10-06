// Feature 2 (T6): dedup on BSP message ID before any respond-path work
// happens. Written AFTER tenant resolution (whatsapp-numbers.table.ts), so
// unlike that table this one IS RLS-scoped — same FORCE + policy pattern as
// tenant_tools (Feature 1). The unique(tenantId, bspMessageId) constraint
// is the actual dedup mechanism: a second insert attempt for the same pair
// throws a unique-violation, which WebhookDedupService.checkAndRecord()
// interprets as "already processed, short-circuit."
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const webhookMessageDedup = pgTable(
  'webhook_message_dedup',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bspMessageId: text('bsp_message_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('webhook_message_dedup_tenant_id_bsp_message_id_unique').on(
      table.tenantId,
      table.bspMessageId,
    ),
  ],
).enableRLS();
