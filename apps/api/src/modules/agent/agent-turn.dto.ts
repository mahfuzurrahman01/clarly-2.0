import type { EscalationReason, EscalationSource } from '@repo/errors';
import type { AgentRunSpans } from '../persistence/drizzle/agent-runs.table';
import type { TurnMedia } from './media/turn-media.dto';

/** Mirrors OnboardingModule's TenantPolicyRecord fields structurally — AgentModule doesn't import OnboardingModule (that's a product-shell module, not one of the AI track's natural collaborators); the caller (a future respond-path orchestrator) reads tenant_policy and passes the fields this turn actually needs. */
export interface AgentTenantPolicyInput {
  tonePersonaOverride: string | null;
  forbiddenTopics: string[];
  confidenceThreshold: number;
  rerankEnabled: boolean;
}

export interface AgentTurnInput {
  tenantId: string;
  /**
   * F25 D6.1 / F26 D4: the turn identity a tool call belongs to, forwarded
   * verbatim into `ToolExecutionContext` at the runtime's single
   * authorize/execute call site.
   *
   * Optional, and null for a non-conversational caller (`CommentReplyAgent`
   * drafts a reply before any conversation or customer exists). Tools that
   * need them fail closed on null — see ToolExecutionContext's doc comment.
   */
  conversationId?: string | null;
  customerId?: string | null;
  /** Stable per respond-path job across BullMQ retries — the coalesced burst's job id, never a fresh UUID. */
  turnId?: string | null;
  /** D7 — async rolling summary; null until one exists. */
  conversationSummary: string | null;
  /** D7 — already capped to the last 10 turns by the caller (ConversationModule/A7, not built yet). */
  recentMessages: Array<{
    role: 'user' | 'assistant' | 'human_agent';
    content: string;
  }>;
  currentMessage: string;
  tenantPolicy: AgentTenantPolicyInput;
  /** F10: pre-rendered "Information to collect" block. Empty/omitted when the agent collects nothing. */
  intakeInstructions?: string;
  /** F9: knowledge-base documents this agent is scoped to. Empty/omitted = the tenant's whole knowledge base. */
  kbDocumentIds?: string[];
  /**
   * F17/A11/A12: images and voice notes attached to this turn, bytes already
   * fetched by the caller. Omitted/empty for a text turn, which then runs the
   * unchanged pre-Feature-17 path.
   */
  media?: TurnMedia[];
}

/** A8 diagnostic: which branch of the bounded loop ended the turn. `escalation_reason` collapses five different loop failures into LLM_ERROR, which made lost turns unattributable and the retry policy untunable (docs/decisions/A0-production-readiness-assessment.md, Round 2 item 4). Diagnostic only — never customer-facing. */
export type EscalationDetail =
  | 'kb_not_indexed'
  | 'forbidden_topic'
  | 'deadline_exceeded'
  /** The deadline passed AFTER a tool had produced a result this turn (possibly a side effect, e.g. an order written), and the one bounded final `respond` call could not deliver an answer. Split from `deadline_exceeded` so these turns — the ones where a human must tell the customer what already happened — can be found. */
  | 'deadline_exceeded_after_tool'
  | 'no_respond_call'
  | 'invalid_respond_payload'
  | 'tool_round_trip_cap'
  | 'tool_scope_violation'
  /** A6 grounding check: the cited passages do not cover the specific thing asked (`NOT_COVERED`). */
  | 'grounding_not_covered'
  /** A6 grounding check: two cited passages state different applicable rules (`CONFLICT`). */
  | 'grounding_conflict'
  | 'malformed_tool_args'
  /** A11 (F17): the attachment could not be read at all — corrupt bytes, a mime type outside the understanding whitelist, oversized, or the vision binding failed/is unconfigured. Escalates as UNSUPPORTED_MEDIA. */
  | 'media_unreadable'
  /** A12 (F17): the audio was fetched and whitelisted, but ASR produced no intelligible transcript after its retry. Also UNSUPPORTED_MEDIA — split out so "we could not hear it" is distinguishable from "we could not open it". */
  | 'transcription_failed'
  | `provider_error:${string}`;

export interface AgentTurnResult {
  answer: string;
  /** F10: values this turn captured, keyed by the tenant's field keys. Empty when nothing was collected. */
  intake?: Record<string, string>;
  citedChunkIds: string[];
  confidence: number;
  escalate: boolean;
  escalationReason: EscalationReason | null;
  escalationSource: EscalationSource | null;
  /** D10: fabricated citation, distinct from "just below threshold" — see escalation-decision.ts's own doc comment. */
  isHallucination: boolean;
  /** Present only on a loop-forced escalation; absent on a normal answer or an agent_decision escalation. */
  escalationDetail?: EscalationDetail;
  promptVersion: string;
  /** A8: token usage summed across every LLM call this turn made (initial + tool round-trips + corrective retries), wall-clock latency for the whole respond() call, and a per-stage span breakdown — the caller (RespondPathProcessor) persists these as one `agent_runs` row, success/escalation/error paths alike. */
  telemetry: AgentRunTelemetryResult;
}

export interface AgentRunTelemetryResult {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  spans: AgentRunSpans;
}
