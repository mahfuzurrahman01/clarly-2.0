// F10 (docs/decisions/F10-intake-fields.md): values the agent collected from
// a customer.
//
// Two tables, not one, because `scope` decides what a value is true OF. An
// order number is true of this conversation; a delivery address is true of
// the person, and re-asking it every thread is the thing this feature exists
// to stop. One bucket would either leak last week's order into this week's
// conversation or lose the address between them.
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { conversations } from './conversations.table';
import { customers } from './customers.table';

/** Latest wins: a customer correcting their order number replaces the wrong one rather than adding a second row nobody can choose between. */
export const conversationIntake = pgTable(
  'conversation_intake',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    value: text('value').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.conversationId, table.fieldKey)],
).enableRLS();

export const customerAttributes = pgTable(
  'customer_attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    value: text('value').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.customerId, table.fieldKey)],
).enableRLS();
