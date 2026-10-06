// Feature 7 (A8, pairs with T9): "Run telemetry. agent_runs schema +
// emission, span breakdown, token + cost accounting." One row per
// RespondPathProcessor invocation of AgentRuntime.respond() — success,
// escalation, AND the T11 exhausted-retry error path all write exactly
// one row (A8's own verify line). Not the same thing as A9's
// `conversation_outcomes` (a separate, smaller, anonymized/permanent
// table meant to survive T16's transcript purge) — this table is the
// detailed, PII-adjacent-by-association telemetry record (tokens, cost,
// per-stage timing), `conversation_outcomes` is the durable rollup
// derived from it.
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { conversations } from './conversations.table';
import { tickets } from './tickets.table';

export const AGENT_RUN_STATUSES = ['success', 'escalated', 'error'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Per-stage wall-clock breakdown in ms — retrieval, LLM calls (summed across every round-trip/retry in the turn), tool execution, guardrail checks. Not every run has every span (e.g. a KBNotIndexed short-circuit never reaches an LLM call), hence a loose jsonb map rather than fixed NOT NULL columns per stage. Canonical definition lives here (PersistenceModule, the schema owner); AgentModule's `agent-run-telemetry.ts` imports this shape rather than defining its own and requiring persistence to depend on the AI track — same "everyone else may import persistence/schema, not the reverse" direction `tenant-tool-registry.service.ts` already establishes. */
export interface AgentRunSpans {
  retrievalMs?: number;
  llmMs?: number;
  toolExecutionMs?: number;
  guardrailMs?: number;
  /** A6 (2026-08-17): the output-side grounding check's own LLM round trip. Separate from `guardrailMs` (which is local, sub-millisecond schema/citation/regex work) because this one is a network call with real cost — folding them together would hide an LLM call inside a span every reader assumes is free. Absent when the check did not run. */
  groundingMs?: number;
  /** A11/A12 (F17): the media-understanding stage — ASR transcription and/or the vision description pre-pass — measured as one span in front of retrieval. Absent on a text turn (never 0: a text turn does not run this stage at all). Its own key rather than folded into `llmMs` because it is a different model on a different endpoint, and an image turn's latency is unreadable if the two are summed. */
  mediaMs?: number;

  // --- P0.3 retrieval sub-spans ---
  //
  // Added deliberately, and deliberately as SUB-spans of `retrievalMs` rather
  // than replacements for it: `retrievalMs` stays the one number the latency
  // budget is written against (docs/decisions/A0-production-readiness-plan.md
  // P0.3, "<400ms"), and everything below explains it. They are additive and
  // optional, so every agent_runs row written before this change stays valid
  // as-is — a missing key means "not measured", never "took 0ms". Any reader
  // of this column must treat all of them as possibly absent.
  //
  // The set is closed on purpose: one key per phase that has a DIFFERENT fix
  // if it dominates (a slow remote embed is fixed by colocation, a slow vector
  // query by index tuning, a slow rerank by the D4 per-tenant flag). Adding a
  // key here is a schema decision, not a logging tweak.

  /** The remote query-embedding HTTP round trip (EMBEDDING_BASE_URL). */
  retrievalEmbedMs?: number;
  /** Of the above, time until response headers arrived — transport + remote compute, no body transfer. Separates "the host is slow" from "the pipe is slow" when read against a same-host baseline. */
  retrievalEmbedHttpTtfbMs?: number;
  /** The pgvector/dense pass. */
  retrievalVectorQueryMs?: number;
  /** The tsvector/lexical pass. */
  retrievalLexicalQueryMs?: number;
  /** RRF fusion + row mapping. Expected ~0; a real value means the candidate set grew. */
  retrievalFusionMs?: number;
  /** The rerank round trip. 0/absent whenever the tenant has D4's rerank flag off. */
  retrievalRerankMs?: number;
}

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  /** Set only when the run escalated or errored and a ticket was actually created for it. */
  ticketId: uuid('ticket_id').references(() => tickets.id, {
    onDelete: 'set null',
  }),
  status: text('status').notNull(),
  escalationReason: text('escalation_reason'),
  escalationSource: text('escalation_source'),
  /** A8 diagnostic (migration 0024): WHICH bounded-loop branch gave up, when one did — `deadline_exceeded`, `no_respond_call`, `provider_error:<code>`, etc. Set once by AgentRuntime at the deciding branch and carried on the turn result; NULL for a normal answer and for a model-initiated `agent_decision` escalation. Engineering-facing only: `escalation_reason` above stays the product-level axis every ticket/rollup reads. */
  escalationDetail: text('escalation_detail'),
  confidence: numeric('confidence', { mode: 'number', precision: 3, scale: 2 }),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  /** USD, 6dp — sub-cent precision matters at per-1M-token rates (e.g. $0.30/1M input). */
  costUsd: numeric('cost_usd', { mode: 'number', precision: 10, scale: 6 })
    .notNull()
    .default(0),
  latencyMs: integer('latency_ms').notNull(),
  spans: jsonb('spans').notNull().default('{}').$type<AgentRunSpans>(),
  promptVersion: text('prompt_version'),
  /**
   * F9 step 2: WHICH agent answered, and with which published configuration.
   *
   * Both nullable. Rows written before F9 have neither, and a run whose
   * agent could not be resolved records the run rather than dropping it —
   * losing telemetry to fix attribution would be the wrong trade.
   *
   * `agentConfigVersion` is the tenant-side half of a pair: `promptVersion`
   * above moves when WE change L0, this moves when a TENANT publishes new
   * configuration. A metrics delta is only attributable with both.
   */
  agentId: uuid('agent_id'),
  agentConfigVersion: integer('agent_config_version'),
  /** Set whenever something went wrong with the turn's machinery: T11's exhausted-retry exception (status='error'), or a WhatsApp delivery failure — which can also land on a status='escalated' row, because a turn that escalated for its own reason AND then failed to deliver keeps the agent's reason as its status while still needing the delivery problem on the record. Same "don't leak internals externally, but log them" discipline as everywhere else; this is an internal telemetry row, not an API response. */
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
