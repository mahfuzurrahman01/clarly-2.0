/**
 * D13's escalation_reason enum (AI_PIPELINE_PLAN.md) — set at the exact call
 * site that decides to escalate, exactly one per escalation. Shared across
 * A4 (loop-forced errors), A5 (confidence decision), A6 (guardrails), and
 * eventually A8/A9 (agent_runs/conversation_outcomes). Lives in
 * @repo/errors, not AgentModule, because RESCUE_POLICY below needs it and
 * RESCUE_POLICY is T1's (this package's) responsibility.
 */
export const ESCALATION_REASONS = [
  'CONFIDENCE_BELOW_THRESHOLD',
  'FORBIDDEN_TOPIC',
  'EXPLICIT_USER_REQUEST',
  /** A4/D6: a tool the agent tried to USE failed — an executing tool threw, or the loop burned its tool round-trip budget without ever reaching `respond`. Strictly about the agent's own tool calls; an outbound WhatsApp send that fails is DELIVERY_FAILURE, never this. Conflating the two made "TOOL_FAILURE rate" unquotable to a tenant: a tenant whose WhatsApp credentials had expired read as a tenant whose agent tooling was broken. */
  'TOOL_FAILURE',
  'TOOL_SCOPE_VIOLATION',
  /** T11/T0 (RespondPathProcessor.deliverAnswer): the agent produced a good answer and the OUTBOUND channel send failed (BSP/Meta HTTP error), so the customer never received it. `error_forced`, decided at the delivery check — never inside the loop, never by the model. Split out of TOOL_FAILURE on 2026-08-17: the two have different owners (our infra/tenant credentials vs. the agent's tools) and different fixes, so they must not share a bucket in A9's escalation mix. Stored as free text (no DB enum on `escalation_reason`), so adding it needs no migration. */
  'DELIVERY_FAILURE',
  /** T11 (`RespondPathProcessor.onFailed`): the respond-path JOB itself crashed and exhausted its BullMQ attempts — an unhandled exception somewhere in the turn's orchestration (missing tenant_policy row, DB error, a non-retryable provider throw that escaped the loop), so no `AgentTurnResult` was ever produced. `error_forced`. Split out of TOOL_FAILURE alongside DELIVERY_FAILURE on 2026-08-17 for the same reason: "our pipeline broke" is a different owner and a different fix from "the agent's tools broke", and `errorMessage` carries the specific cause. */
  'JOB_FAILURE',
  'UNSUPPORTED_MEDIA',
  'KB_NOT_INDEXED',
  /** A6/D12 (2026-08-17, `AnswerGroundingVerifierService`): the knowledge base IS indexed and DID return relevant passages, but two of the cited passages state different rules that both apply to the question, so no answer can be given without choosing between them. Distinct from KB_NOT_INDEXED ("nothing covers this") because the fix is different: a human has to reconcile the tenant's documents, and the tenant needs to be told which two disagree. Set at the grounding check's call site, never by the model. */
  'KB_CONFLICT',
  'LLM_ERROR',
  'WA_WINDOW_CLOSED',
  /** T17/T20 (Feature 8): a tenant's monthly message limit or spend cap (`plans.monthlyMessageLimit`/`monthlySpendCapUsd`) is exceeded — set BEFORE `AgentRuntime.respond()` is ever called for the turn (RespondPathProcessor's own pre-flight check), never inside the loop itself. T17's own line: "a deterministic degrade (escalate-to-human, not silent LLM skip or unbounded spend)." */
  'USAGE_CAP_EXCEEDED',
  /** L0 (PROMPT_VERSION v3): the customer is angry, threatening, distressed, or reporting harm/loss. A model-initiated `agent_decision` escalation that fires even when retrieval fully supports an answer — tone, not confidence, is the trigger, so it must not be conflated with CONFIDENCE_BELOW_THRESHOLD when reading escalation mix. Stored as free text (no DB enum on `escalation_reason`), so adding it needs no migration. */
  'CUSTOMER_DISTRESS',
  /** F25/D5 (L0, PROMPT_VERSION bump): the customer is reporting a problem with something they have ALREADY bought or received — damaged, wrong item, late, missing, or demanding a refund. A model-initiated `agent_decision` escalation, the same shape as CUSTOMER_DISTRESS and for the same reason: no new classifier, no second confidence formula. Deliberately distinct from CUSTOMER_DISTRESS (which is about TONE — angry, threatening, distressed) and from EXPLICIT_USER_REQUEST (the customer asked for a person); a calm, polite "the box arrived dented" is a complaint and neither of the other two. The console's Complaints lane is a filter over this value (`GET /kanban/tickets?escalationReason=CUSTOMER_COMPLAINT`), not a new column or a new board. Stored as free text (no DB enum on `escalation_reason`), so adding it needs no migration. */
  'CUSTOMER_COMPLAINT',
  /** Consent (2026-08-22, WebhookIngestService): the customer has opted out of automated messaging but sent us a message anyway. They re-opened the service window themselves, so their message must reach a human — but an opt-out is not consent to be auto-replied to, so the agent never runs for this turn. Set at ingest, before the respond path is queued, never by the model. */
  'OPTED_OUT_CUSTOMER',
  /** Launch billing backend, Lane A (RespondPathProcessor's pre-flight, ahead of USAGE_CAP_EXCEEDED): the tenant has no ENTITLEMENT at all — no subscription row, an expired trial, or a lapsed (past_due/canceled/incomplete) subscription, per UsageService.checkEntitlement()'s `allowed`/`blockReason`. Distinct from USAGE_CAP_EXCEEDED, which is a tenant WITH a working subscription who is over their own configured cap; this is a tenant with no working subscription to check a cap against at all. Set before AgentRuntime.respond() is ever called, same as USAGE_CAP_EXCEEDED — but unlike that path, a billing-blocked turn does not run the agent, download media, or send an outbound reply at all (see RespondPathProcessor's own comment at this check). */
  'BILLING_BLOCKED',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** D13: keeps confidence-driven escalations from being conflated with LLM-outage-driven ones. */
export const ESCALATION_SOURCES = ['agent_decision', 'error_forced'] as const;
export type EscalationSource = (typeof ESCALATION_SOURCES)[number];
