import type { EscalationReason, EscalationSource } from '@repo/errors';
import type { EscalationDetail } from '../agent/agent-turn.dto';
import type {
  AgentRunSpans,
  AgentRunStatus,
} from '../persistence/drizzle/agent-runs.table';

export interface RecordAgentRunInput {
  tenantId: string;
  conversationId: string | null;
  ticketId: string | null;
  status: AgentRunStatus;
  escalationReason: EscalationReason | null;
  escalationSource: EscalationSource | null;
  /**
   * A8: the engineering-level companion to `escalationReason` — WHICH branch
   * of the bounded loop gave up. Type-only import from AgentModule on
   * purpose: the union (including the open-ended `provider_error:<code>`
   * form) is AgentModule's contract, exactly as `AgentRunSpans` is
   * PersistenceModule's, and a type-only import erases at compile time so no
   * runtime dependency is created in either direction.
   *
   * Null is meaningful and must stay distinguishable from any detail value:
   * the run never took a forced-escalation branch (a normal answer, or a
   * model-initiated `agent_decision` escalation). Callers pass
   * `result.escalationDetail ?? null` — never a placeholder string.
   */
  escalationDetail: EscalationDetail | null;
  /**
   * F9 step 2: which agent answered, and with which published configuration
   * version. Both null when the agent could not be resolved — the run is
   * still recorded, because losing telemetry to fix a label is the wrong
   * trade (see AgentConfigService.resolveForPhoneNumber()).
   */
  agentId: string | null;
  agentConfigVersion: number | null;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  spans: AgentRunSpans;
  promptVersion: string | null;
  errorMessage: string | null;
}
