// F9 step 1 (docs/decisions/F9-agent-configuration.md): the agent entity
// itself — identity and lifecycle only. Every configurable VALUE lives on
// `agent_versions`, so this row can point at two of them at once: the
// published configuration answering customers, and the draft a tenant is
// still editing.
//
// Splitting it this way is what makes rollback and attribution possible:
// a published version is never mutated, so `agent_runs.agent_config_version`
// (step 2) always identifies configuration that still exists exactly as it
// ran. Editing produces a draft; publishing points `publishedVersionId` at
// a frozen copy.
//
// THIS PASS is deliberately behaviour-preserving: the tables exist and are
// backfilled from `tenant_policy`, but nothing reads them on the respond
// path yet. Routing (`whatsappNumberId` -> agent) lands in step 2.
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/**
 * `draft` — never answered a customer; exists to be edited and tested.
 * `published` — live configuration, reachable by routing.
 * `archived` — kept for the audit trail and for old `agent_runs` rows to
 * still resolve against; never routed to.
 */
export const AGENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Console-facing label. Never rendered into a prompt — an agent's name is not something the model should read as identity. */
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    /**
     * The number this agent answers on (step 2's routing key). Nullable:
     * an agent can be drafted and tested in the sandbox before a number is
     * bound to it. No FK to `whatsapp_numbers` yet — the binding's
     * uniqueness rule (one number, one agent) is decided with the routing
     * change that enforces it, not here.
     */
    whatsappNumberId: uuid('whatsapp_number_id'),
    /** The live configuration. Null for an agent that has never been published. */
    publishedVersionId: uuid('published_version_id'),
    /** Unpublished edits. Null when there are none — a tenant who has not touched a published agent has no draft. */
    draftVersionId: uuid('draft_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Names are how a tenant tells two agents apart in the console; duplicates
  // make every other screen ambiguous.
  (table) => [unique().on(table.tenantId, table.name)],
).enableRLS();
