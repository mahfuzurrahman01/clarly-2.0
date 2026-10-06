// F9 step 1: one immutable-once-published snapshot of everything a tenant
// can configure about an agent. This is the "agent instruction set" half of
// the two-authority split in docs/decisions/F9-agent-configuration.md — the
// platform half (L0) is code, versioned by PROMPT_VERSION, and nothing here
// can override it.
//
// TYPED COLUMNS, NOT A jsonb BLOB. A blob would be quicker to write and
// would cost us the three things this table exists for: diffing two
// versions to show a tenant what actually changed, validating a value at
// the database rather than at whichever code path happens to read it, and
// answering questions across agents ("which of these still escalate below
// 0.5?"). It also keeps the field set — and therefore the boundary of what
// a tenant may express — legible in one place.
//
// Every free-text field below is sanitized and length-capped at the
// PromptModule layer before rendering (the existing
// `sanitizeTenantPersona()` treatment), same as L1 does today. That is
// presentation hygiene, not the guardrail boundary: `forbiddenTopics` is
// still enforced deterministically by GuardrailModule (D12), and the
// always-on behaviours in F9 Decision 2 — citations, distress escalation,
// sensitive-data refusal, KB-conflict escalation, prompt secrecy — have no
// column here at all, precisely so no configuration can switch them off.
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { agents } from './agents.table';
import type { IntakeField } from '../../agent-config/intake-fields';

/** Rendered into L1. An enum rather than free text because tone is the field tenants most often over-specify, and four predictable options beat a paragraph the model half-follows. */
export const AGENT_TONES = ['formal', 'friendly', 'concise', 'warm'] as const;
export type AgentTone = (typeof AGENT_TONES)[number];

/**
 * OPTIONAL escalation triggers a tenant may switch on. The always-on set
 * (distress, sensitive data, KB conflict, no coverage, named-authority
 * rules) is deliberately absent — those are L0's, and a tenant can add
 * caution here but never remove it.
 */
export const OPTIONAL_ESCALATION_TRIGGERS = [
  'negative_sentiment',
  'repeat_question',
  'refund_request',
  'order_change',
  'complaint',
] as const;
export type OptionalEscalationTrigger =
  (typeof OPTIONAL_ESCALATION_TRIGGERS)[number];

export const agentVersions = pgTable(
  'agent_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Monotonic per agent, starting at 1. This is what `agent_runs.agent_config_version` records (step 2), so it must never be reused. */
    version: integer('version').notNull(),

    // --- Identity -> L1 -------------------------------------------------
    /** What this agent is for: "You handle order and delivery questions for a clothing brand." */
    roleDescription: text('role_description'),
    /** Today's `tenant_policy.tone_persona_override`, carried over unchanged by the step-1 backfill. */
    persona: text('persona'),
    /** See AGENT_TONES. Null renders nothing, which is what keeps the backfill behaviour-preserving. */
    tone: text('tone'),
    /** Languages the agent should reply in. Empty means L0's existing "reply in the language the customer wrote in" rule stands alone. */
    languages: jsonb('languages').notNull().default('[]').$type<string[]>(),
    /** First-contact line. Null leaves L0's greeting rule untouched. */
    greeting: text('greeting'),
    /** What it says when the knowledge base does not cover the question. It still escalates either way — this only changes the wording. */
    outOfScopeResponse: text('out_of_scope_response'),

    // --- Scope and policy -> L2 ----------------------------------------
    /** Restated in L2 for defense in depth; ENFORCED by GuardrailModule's embedding check at intake (D12). */
    forbiddenTopics: jsonb('forbidden_topics')
      .notNull()
      .default('[]')
      .$type<string[]>(),
    /** Opening hours per weekday. Null means 24/7, which is today's behaviour. Shape is settled with the feature that reads it, not here. */
    businessHours: jsonb('business_hours'),
    /** IANA zone. Required for businessHours to mean anything; null while businessHours is null. */
    timezone: text('timezone'),
    outOfHoursResponse: text('out_of_hours_response'),
    /** See OPTIONAL_ESCALATION_TRIGGERS. Additive only. */
    escalationTriggers: jsonb('escalation_triggers')
      .notNull()
      .default('[]')
      .$type<OptionalEscalationTrigger[]>(),

    /**
     * F10: what the agent should collect from a customer, as
     * `[{ key, label, type, required, choices?, scope }]`.
     *
     * Versioned with the rest of the configuration, unlike the number binding
     * and document scope: these render into the prompt, so they change how
     * the agent behaves, and a rollback that restored an old persona while
     * leaving new fields being collected would produce a configuration that
     * never existed.
     */
    intakeFields: jsonb('intake_fields')
      .notNull()
      .default('[]')
      .$type<IntakeField[]>(),

    // --- Behaviour (no prompt text) ------------------------------------
    /** A5's escalation threshold. Same column semantics as tenant_policy's, including `mode: 'number'`. */
    confidenceThreshold: numeric('confidence_threshold', {
      precision: 3,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0.7),
    rerankEnabled: boolean('rerank_enabled').notNull().default(true),
    stuckTicketThresholdMinutes: integer('stuck_ticket_threshold_minutes')
      .notNull()
      .default(15),
    /** Currently the platform constant `HANDOVER_AUTO_RETURN_MINUTES`; the default here is that same value, so making it configurable changes nothing until a tenant edits it. */
    handoverAutoReturnMinutes: integer('handover_auto_return_minutes')
      .notNull()
      .default(60),
    /** Cost ceiling per turn. Defaults to the agent loop's existing `MAX_TOOL_ROUND_TRIPS`. */
    maxToolCallsPerTurn: integer('max_tool_calls_per_turn')
      .notNull()
      .default(2),

    // --- Lifecycle ------------------------------------------------------
    /** Null while this version is a draft. Set once, at publish — a published version is never edited again. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Supabase auth `sub` of whoever created this version. Not an FK: auth.users lives outside this database, same as tickets.assignee_id. */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.agentId, table.version)],
).enableRLS();
