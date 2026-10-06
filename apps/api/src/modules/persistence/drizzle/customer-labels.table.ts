// Feature 18 (Intent Labeling, Clarly Blueprint pillar 4): the customer-facing
// label derived from A5's per-turn escalation/confidence decision (D10) — one
// row per customer, not per turn. A5 already computes the signal for every
// message; this table is the first thing to expose it as a durable, human-
// correctable property of the CUSTOMER rather than a purely internal, per-turn
// escalation decision.
//
// Grain: one row per (tenant, customer). `customers` is already exactly one row
// per (tenant, phone), which is the grain "how hot is this lead" is expressed
// at. A per-turn history table would be a different feature (and A8's
// `agent_runs` already keeps the per-turn record, including the confidence and
// escalation reason this label was derived from) — this is deliberately the
// current state only.
//
// Separate table rather than a column on `customers` (unlike Feature 5's
// consent columns, which DID go on `customers`): a label carries four
// correlated fields — value, who last set it, when the agent last evaluated,
// and the override marker — that are meaningless individually, and Feature 19's
// segment builder queries this as its own indexed relation.
//
// OVERRIDE-WINS PRECEDENCE (locked decision, Feature 18 of the former plan):
// once a human sets `overridden_at`, agent-derived writes must not overwrite the
// label until a human explicitly clears it. That rule is enforced in SQL, in the
// `ON CONFLICT ... WHERE customer_labels.overridden_at IS NULL` clause of
// CustomerLabelService.applyAgentSignal() — NOT by reading the row first and
// deciding in TypeScript. A read-then-write would lose the race against a human
// pressing override in the console while a turn is in flight, which is precisely
// the moment the rule exists to protect.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  foreignKey,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { customers } from './customers.table';
import { tenants } from './tenants.table';

/**
 * The labels the agent itself can derive. A tenant may store any other string
 * via a human override (the spec's "or tenant-defined"), so the column is
 * `text`, not a DB enum — but the AGENT only ever writes one of these three,
 * because these are the only three the A5 signal can justify.
 */
export const AGENT_CUSTOMER_LABELS = ['hot', 'warm', 'cold'] as const;
export type AgentCustomerLabel = (typeof AGENT_CUSTOMER_LABELS)[number];

export const customerLabels = pgTable(
  'customer_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** See the COMPOSITE foreign key below — deliberately not a bare `references(customers.id)`. */
    customerId: uuid('customer_id').notNull(),
    /** Free text: `AGENT_CUSTOMER_LABELS` when agent-derived, anything the tenant wants when human-set. */
    label: text('label').notNull(),
    /**
     * When a human last overrode the label. Non-null is the whole precedence
     * rule: while it is set, `applyAgentSignal()` writes nothing.
     */
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    /** Who overrode it. Not an FK — users do not live in this database (same reason as `messages.author_user_id`). */
    overriddenBy: uuid('overridden_by'),
    /**
     * When an A5 decision last EVALUATED this customer — updated even while an
     * override suppresses the label write, so the console can honestly say
     * "the agent has looked at this since you overrode it" rather than
     * implying the agent went quiet.
     */
    agentEvaluatedAt: timestamp('agent_evaluated_at', { withTimezone: true }),
    /**
     * What the agent WOULD have set on its most recent evaluation, kept even
     * while an override is in force. Without it, clearing an override leaves the
     * label frozen at the human's value until the customer happens to message
     * again — and an agent that disagrees with the human is invisible to the
     * person deciding whether to keep the override.
     */
    agentLabel: text('agent_label').$type<AgentCustomerLabel>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.tenantId, table.customerId),
    /**
     * COMPOSITE, on purpose. A per-column FK to `customers.id` would let a
     * caller write a label row under THEIR tenant pointing at another tenant's
     * customer id: RLS' WITH CHECK only constrains `tenant_id`, and the FK
     * would be satisfied because that customer really does exist. Nothing
     * leaks (the attacker still cannot read the victim's rows), but the row
     * would be junk, and Feature 19 segments built on it would be wrong.
     * (tenant_id, customer_id) -> (customers.tenant_id, customers.id) makes
     * that write impossible in the database, not just in the controller.
     */
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    // Feature 19's segment builder filters by (tenant, label); the kanban
    // ticket list joins by (tenant, customer). The unique index above already
    // serves the second, so only the first needs its own.
    index('customer_labels_tenant_label_idx').on(table.tenantId, table.label),
  ],
).enableRLS();
