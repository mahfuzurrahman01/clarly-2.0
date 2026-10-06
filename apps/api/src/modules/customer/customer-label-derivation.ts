// Feature 18: A5's escalation decision -> a customer label.
//
// Deliberately pure and DI-free, same rationale as escalation-decision.ts
// (A5) and the guardrail predicates: it is a rule, not a service, and it must
// be exhaustively unit-testable without a database.
//
// It REUSES A5's signal and computes nothing new — no second LLM call, no
// second confidence formula. The inputs below are exactly the fields
// `AgentTurnResult` already carries out of `computeEscalationDecision()`;
// typed against @repo/errors' shared enums rather than AgentModule's DTOs so
// CustomerModule (product shell) does not take a dependency on AgentModule.
import type { EscalationReason, EscalationSource } from '@repo/errors';
import type { AgentCustomerLabel } from '../persistence/drizzle/schema';

export interface AgentLabelSignal {
  escalate: boolean;
  escalationReason: EscalationReason | null;
  /** D13: `agent_decision` vs `error_forced`. The distinction is load-bearing here — see below. */
  escalationSource: EscalationSource | null;
}

/**
 * Escalation reasons that mean *the customer asked for, or visibly needs, a
 * person* — as opposed to the agent merely being unable to answer. These are
 * the highest-intent contact we can identify from A5's signal alone.
 */
const HUMAN_DEMANDED_REASONS: ReadonlySet<EscalationReason> = new Set([
  'EXPLICIT_USER_REQUEST',
  'CUSTOMER_DISTRESS',
  // F25/D5.1 item 3: a complaining customer is the highest-intent contact
  // there is — they have already bought, and whether they buy again is being
  // decided right now. F19's segments read this label.
  'CUSTOMER_COMPLAINT',
]);

/**
 * The label A5's decision justifies, or `null` when the decision says nothing
 * about the customer at all.
 *
 * The mapping, and why each branch is what it is:
 *
 * - `error_forced` (LLM_ERROR, DELIVERY_FAILURE, JOB_FAILURE,
 *   USAGE_CAP_EXCEEDED, ...) -> **null, no label write**. D13 exists precisely
 *   to keep infrastructure failures from being read as agent decisions. Our
 *   provider timing out tells us nothing about how interested the customer is,
 *   and letting it relabel them would make every outage look like a wave of
 *   cold leads.
 * - escalated because the customer asked for a human, or is distressed ->
 *   **hot**. Someone is waiting on a person; that is the strongest buying/
 *   churn signal this pipeline produces.
 * - escalated for any other agent-decided reason (confidence below threshold,
 *   KB gaps, tool failures) -> **warm**. The conversation needs attention, but
 *   the trigger was the agent's own limitation, not a customer signal.
 * - answered end-to-end with no escalation -> **cold**. A question the FAQ
 *   pipeline fully handled is, by definition, routine contact.
 *
 * Three states, derived from fields that already exist. If a tenant wants a
 * different taxonomy they set it by hand — that is what the override is for,
 * and once set the agent stops writing (override-wins).
 */
export function deriveAgentLabel(
  signal: AgentLabelSignal,
): AgentCustomerLabel | null {
  if (signal.escalationSource === 'error_forced') return null;

  if (!signal.escalate) return 'cold';

  return signal.escalationReason &&
    HUMAN_DEMANDED_REASONS.has(signal.escalationReason)
    ? 'hot'
    : 'warm';
}
