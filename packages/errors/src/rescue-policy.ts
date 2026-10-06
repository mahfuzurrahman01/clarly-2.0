// T1's rescue-action table: exactly one policy row per AgentError subclass,
// implemented as data rather than scattered try/catch conventions per
// call site — same "policy as data" rationale as tenant_policy (F2.5) and
// tool-registry's Zod-schemas-as-data. BACKEND_PLAN.md T1 references a
// "source plan['s] Error & Rescue Registry" that isn't checked into this
// repo; this table is this repo's actual registry, designed from each
// class's own owner/rationale comment (agent-error.ts subclasses) plus
// D2's circuit-breaker requirement and D13's escalation_reason enum.
//
// `escalationReason: null` means "not a direct per-conversation escalation
// on its own" — WARateLimitError/WATemplateRejected/WANumberQualityDrop are
// send-path failures that retry or feed T4's AlertingModule, not a
// customer-facing conversation outcome by themselves; the caller (send
// path) decides whether an exhausted retry becomes a TOOL_FAILURE
// escalation for that specific conversation.
import type { EscalationReason } from './escalation-reason';

export interface RescuePolicy {
  /** Whether the caller (A4's loop, breaker, send path) should retry before giving up. */
  retryable: boolean;
  /** Only meaningful when retryable. */
  maxAttempts?: number;
  backoffMs?: number;
  /** D13 escalation_reason once retries are exhausted (or immediately, if not retryable). null = no direct conversation-level escalation; caller/alerting decides. */
  escalationReason: EscalationReason | null;
  /** Whether this class's failures count toward D2's circuit breaker (LLM provider outage detection). */
  countsTowardBreaker: boolean;
}

export const RESCUE_POLICY: Record<string, RescuePolicy> = {
  // A0/D2: consecutive timeouts/5xx open the breaker; once open, the respond
  // path skips the LLM entirely rather than keep retrying into an outage.
  LLM_TIMEOUT: {
    retryable: true,
    maxAttempts: 2,
    backoffMs: 500,
    escalationReason: 'LLM_ERROR',
    countsTowardBreaker: true,
  },
  // D9: the Cloudflare Access edge rejected the request before it reached
  // the self-hosted host — a bad/expired service token, never something a
  // retry fixes. Counts toward the breaker (see AiHostAuthFailed's own doc
  // comment): from the caller's view this fails every call identically,
  // exactly like a real provider outage, and D2's breaker + T18 alerting
  // are the paging path this is meant to reach.
  AI_HOST_AUTH_FAILED: {
    retryable: false,
    escalationReason: 'LLM_ERROR',
    countsTowardBreaker: true,
  },
  // A4: empty content is often transient (provider hiccup); one corrective
  // retry per D6's loop bound before treating it as a real failure.
  LLM_EMPTY_RESPONSE: {
    retryable: true,
    maxAttempts: 1,
    backoffMs: 250,
    escalationReason: 'LLM_ERROR',
    countsTowardBreaker: true,
  },
  // A4: retrying the identical prompt after a refusal reliably reproduces
  // the refusal (D1's DeepSeek-asymmetry note) — not retryable.
  LLM_REFUSAL: {
    retryable: false,
    escalationReason: 'LLM_ERROR',
    countsTowardBreaker: false,
  },
  // A4/D6: exactly the "1 corrective retry" the bounded loop budgets for —
  // reformat the tool call once, then give up rather than loop.
  LLM_MALFORMED_TOOL_CALL: {
    retryable: true,
    maxAttempts: 1,
    backoffMs: 0,
    escalationReason: 'LLM_ERROR',
    countsTowardBreaker: false,
  },
  // T3/T0: BSP-specific rate limiting — retry with backoff respecting the
  // BSP's Retry-After when present; a send-path concern, not a
  // conversation-quality one, so no escalation reason of its own.
  WA_RATE_LIMIT: {
    retryable: true,
    maxAttempts: 3,
    backoffMs: 1000,
    escalationReason: null,
    countsTowardBreaker: false,
  },
  // T0: an invalid/unapproved template will fail identically on retry.
  WA_TEMPLATE_REJECTED: {
    retryable: false,
    escalationReason: null,
    countsTowardBreaker: false,
  },
  // T4: signal, not a per-message failure — feeds AlertingModule, never
  // retried or escalated at the conversation level.
  WA_NUMBER_QUALITY_DROP: {
    retryable: false,
    escalationReason: null,
    countsTowardBreaker: false,
  },
  // D9: the 24h window is a hard BSP constraint; retrying changes nothing
  // until the customer messages again.
  WA_WINDOW_CLOSED: {
    retryable: false,
    escalationReason: 'WA_WINDOW_CLOSED',
    countsTowardBreaker: false,
  },
  // Feature 16: the same hard constraint on Messenger/Instagram, and the
  // same verdict — the window reopens when the customer writes again, never
  // because we tried a second time. Shares WA_WINDOW_CLOSED's D13
  // escalation_reason deliberately (see ChannelWindowClosedError): the
  // reason a human is now involved is identical, and forking it would split
  // one bucket in A9's escalation mix into three for no reader's benefit.
  CHANNEL_WINDOW_CLOSED: {
    retryable: false,
    escalationReason: 'WA_WINDOW_CLOSED',
    countsTowardBreaker: false,
  },
  // A1: an un-ingested KB is a configuration state, not a transient fault.
  KB_NOT_INDEXED: {
    retryable: false,
    escalationReason: 'KB_NOT_INDEXED',
    countsTowardBreaker: false,
  },
  // A11/A12 (Feature 17): corrupt, oversized, or non-whitelisted media. The
  // same bytes fail identically on retry, so this goes straight to the T3
  // escalation reason it always had — the difference after Feature 17 is
  // that only media we genuinely cannot read reaches this row.
  MEDIA_UNREADABLE: {
    retryable: false,
    escalationReason: 'UNSUPPORTED_MEDIA',
    countsTowardBreaker: false,
  },
  // A12: one retry — an ASR call is a network call, and a transient failure
  // there should not cost the customer a human handoff. After that it is an
  // UNSUPPORTED_MEDIA escalation, never a silent drop. Not counted toward
  // D2's breaker: ASR runs on its own model/endpoint, and an ASR outage must
  // not open the breaker on the text path.
  TRANSCRIPTION_FAILED: {
    retryable: true,
    maxAttempts: 2,
    backoffMs: 250,
    escalationReason: 'UNSUPPORTED_MEDIA',
    countsTowardBreaker: false,
  },
  // T2: security-critical — never retried (retrying doesn't change scope),
  // never leaks detail to the attacker-facing side.
  TOOL_SCOPE_VIOLATION: {
    retryable: false,
    escalationReason: 'TOOL_SCOPE_VIOLATION',
    countsTowardBreaker: false,
  },
};

/** Looks up an AgentError's rescue policy by its `.code`. Throws on an unknown code — a missing policy row is a T1 registry bug, not a runtime condition to swallow. */
export function getRescuePolicy(code: string): RescuePolicy {
  const policy = RESCUE_POLICY[code];
  if (!policy) {
    throw new Error(`No rescue policy registered for error code "${code}" — add one to RESCUE_POLICY.`);
  }
  return policy;
}
