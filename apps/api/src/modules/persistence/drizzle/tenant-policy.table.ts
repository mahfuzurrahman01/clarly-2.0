// Feature 2.5 (T15): the guardrail/policy fields BACKEND_PLAN.md's
// "Guardrail / Policy Layer" section already specced without an owning
// table — confidence threshold (A5's escalation decision), forbidden
// topics (A6's deterministic guardrail check), tone/persona override (L1
// of D11's prompt layers). One row per tenant; `tenantId` IS the primary
// key rather than a separate `id` since a tenant has at most one policy
// row by definition.
//
// RLS: same FORCE + NULLIF guard pattern as tenant_tools (Feature 1) /
// webhook_message_dedup, tickets (Feature 2). Read by A5/A6 (Feature 3);
// write access today is script/seed only (TenantPolicyService, no HTTP
// endpoint) — Feature 6's OnboardingModule adds the real admin-only API
// (T14 role-gated) on top, per the former feature plan's "no onboarding UX" note.
import {
  pgTable,
  uuid,
  numeric,
  jsonb,
  text,
  boolean,
  integer,
  timestamp,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const tenantPolicy = pgTable('tenant_policy', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** A5's escalation threshold — default 0.7 per BACKEND_PLAN.md's Guardrail/Policy Layer spec. `mode: 'number'` so callers get a JS number, not Postgres numeric's default string. */
  confidenceThreshold: numeric('confidence_threshold', {
    precision: 3,
    scale: 2,
    mode: 'number',
  })
    .notNull()
    .default(0.7),
  /** A6 reads this for the embedding-similarity forbidden-topic check at intake. */
  forbiddenTopics: jsonb('forbidden_topics')
    .notNull()
    .default('[]')
    .$type<string[]>(),
  /** D11 L1 — free-text, length-capped/sanitized at the PromptModule layer (Feature 3), not here. */
  tonePersonaOverride: text('tone_persona_override'),
  /** D4: "rerank behind a per-tenant flag in case it threatens the T9 latency budget." Default true — RetrievalModule's search treats a missing/true value as "attempt rerank if a reranker is configured," not "rerank is mandatory." */
  rerankEnabled: boolean('rerank_enabled').notNull().default(true),
  /** T4: "unclaimed after N minutes (tenant-configurable, default 15)." */
  stuckTicketThresholdMinutes: integer('stuck_ticket_threshold_minutes')
    .notNull()
    .default(15),
  /** F19 (D3): per-tenant default for a new campaign's `spend_cap_usd` when the merchant does not set one explicitly. */
  campaignDefaultSpendCapUsd: numeric('campaign_default_spend_cap_usd', {
    precision: 10,
    scale: 2,
    mode: 'number',
  })
    .notNull()
    .default(50),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
