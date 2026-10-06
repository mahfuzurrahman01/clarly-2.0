import { AgentError } from './agent-error';

/**
 * D9: the self-hosted inference/embedding host sits behind a Cloudflare
 * Access service token (CF-Access-Client-Id / CF-Access-Client-Secret), not
 * a vendor API key — a missing, wrong, or EXPIRED token returns HTTP 401/403
 * from the Cloudflare edge itself, before the request ever reaches the vLLM
 * box. That is a distinct failure mode from LLMTimeout (the box is up but
 * slow/erroring) and must not be folded into it: an expired service token
 * fails every single call identically, forever, until someone rotates it —
 * retrying it is pointless, and a generic "LLM provider error" log line
 * would send whoever's paging at the wrong problem (the model vs. the edge
 * auth). See the Launch Plan's failure-modes table: "Tunnel auth: Service
 * token expires -> all replies fail... visible via paging" — this class is
 * what makes it visible rather than folding into an unlabeled timeout.
 *
 * Owner: T1/A0. countsTowardBreaker: true (rescue-policy.ts) — an expired
 * token should open D2's circuit breaker exactly like a real outage, since
 * from the respond path's point of view every call is failing the same way.
 */
export class AiHostAuthFailed extends AgentError {
  constructor(message = 'Self-hosted AI host rejected the request as unauthenticated') {
    super('AI_HOST_AUTH_FAILED', message);
  }
}
