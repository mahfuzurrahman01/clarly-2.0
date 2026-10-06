// Feature 2 minimal slice ALTERed by Feature 5 (T7/T8/T13/T14), per this
// file's own original header comment ("Feature 5 is expected to ALTER this
// table... not replace it"):
//   - `customerId` (T13) — every ticket now references the persistent
//     customer profile, not a raw phone string.
//   - `conversationId` (nullable — T3's unsupported-media path doesn't
//     always have run a full agent turn) — lets T8's batch loader join
//     straight to `messages` for transcript context in one query.
//   - `assigneeId` (T7/T14, nullable, NO local FK) — the claiming human
//     agent's Supabase Auth user id (`sub` claim). No FK constraint: the
//     referenced row lives in Supabase's own `auth.users` table, which
//     doesn't exist in local dev/docker-compose Postgres at all (only in
//     a real Supabase project) — same reasoning as tenant_id's JWT-sourced
//     trust boundary (F1-security.md), just for a different claim.
//   - `confidence`/`citedChunkIds` (nullable) — captured at ticket-creation
//     time directly from `AgentTurnResult` when an agent run actually
//     produced the escalation (RespondPathProcessor's new path, Feature
//     4/5) — this is what satisfies T8's "batch-load ... confidence score
//     per ticket" without needing A8's full `agent_runs` telemetry table
//     (deferred, out of scope). Null for T3/T11's non-agent-run tickets.
//   - `claimedAt`/`resolvedAt` (nullable) — T4's stuck-ticket check
//     ("unclaimed after N minutes") reads `claimedAt IS NULL AND
//     createdAt < now() - threshold`; `resolvedAt` is the closure
//     timestamp A9's resolution-rate rollup reads.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
} from 'drizzle-orm/pg-core';
import { ESCALATION_REASONS, type EscalationReason } from '@repo/errors';
import { tenants } from './tenants.table';
import { customers } from './customers.table';
import { conversations } from './conversations.table';

/** D13's escalation_reason enum (AI_PIPELINE_PLAN.md), the same values @repo/errors' RESCUE_POLICY already uses — one shared source, not a parallel list that could drift. Every value is reachable now that Feature 4 wires AgentRuntime into RespondPathProcessor (was a narrower Feature-2-only subset before). */
export const TICKET_ESCALATION_REASONS = ESCALATION_REASONS;
export type TicketEscalationReason = EscalationReason;

export const TICKET_STATUSES = ['OPEN', 'CLAIMED', 'RESOLVED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  escalationReason: text('escalation_reason').notNull(),
  status: text('status').notNull().default('OPEN'),
  /** Free-text context (e.g. bspMessageId, media type, job id) — structured handoff-context assembly is T8's batch loader, not this field. */
  note: text('note'),
  /** Supabase Auth `sub` claim of the claiming agent — see header comment for why there's no FK. */
  assigneeId: uuid('assignee_id'),
  /** D10's composite confidence at escalation time, when an agent run actually produced this ticket. */
  confidence: numeric('confidence', { precision: 3, scale: 2, mode: 'number' }),
  citedChunkIds: jsonb('cited_chunk_ids').$type<string[]>(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
