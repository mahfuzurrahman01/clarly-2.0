// Feature 7 (A9, "conversation close resolver, conversation_outcomes
// (anonymized, permanent)"): the durable rollup source for
// resolution-rate/escalation-breakdown reporting — distinct from A8's
// `agent_runs` (the detailed per-turn telemetry record this table
// summarizes from). "Anonymized": no phone/customer data at all, just
// tenant + aggregate signal. "Permanent": T12's guarantee is that a
// future 90-day transcript purge (T16, not built yet) removes raw
// `messages`/`conversations` rows but must NOT touch this table — which
// is exactly why `conversationId` below is a plain uuid, NOT a foreign
// key. A real FK with `onDelete: 'cascade'` (the pattern every other
// conversation-scoped table in this schema uses) would silently defeat
// T12 the moment T16's purge job deletes a `conversations` row: the
// cascade would delete this outcome too. `tenantId` keeps its normal FK
// + cascade — full tenant offboarding (also T16, a different operation
// than transcript purge) is expected to remove everything for that
// tenant, outcomes included.
import {
  pgTable,
  uuid,
  boolean,
  integer,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const CONVERSATION_CLOSE_REASONS = [
  'ticket_resolved',
  'inactivity_timeout',
] as const;
export type ConversationCloseReason =
  (typeof CONVERSATION_CLOSE_REASONS)[number];

export const conversationOutcomes = pgTable('conversation_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Deliberately NOT a foreign key — see this file's header comment. */
  conversationId: uuid('conversation_id').notNull(),
  escalated: boolean('escalated').notNull(),
  escalationReason: text('escalation_reason'),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
  /**
   * Phase 5 item 1: milliseconds from the customer's FIRST inbound message in
   * this conversation to the first reply that followed it — AI or human, since
   * the customer experiences one wait either way. Captured at close time from
   * `messages`, because T16's transcript purge will remove the rows it is
   * derived from (this table survives that purge; see the header comment).
   *
   * Null when the conversation closed without any reply after the first inbound
   * message, and on every row written before 2026-09-22.
   */
  firstResponseMs: integer('first_response_ms'),
  closeReason: text('close_reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
