import { AgentError } from './agent-error';

/** BSP rejected a send due to rate limiting. Owner: T1/T0 (BSP-specific mapping). */
export class WARateLimitError extends AgentError {
  constructor(message = 'WhatsApp BSP rate limit exceeded') {
    super('WA_RATE_LIMIT', message);
  }
}
