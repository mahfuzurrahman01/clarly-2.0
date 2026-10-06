import { AgentError } from './agent-error';

/**
 * The 24hr WhatsApp customer-service window is closed for this conversation,
 * so a live free-form message cannot be sent (D9). Owner: T1/T3.
 */
export class WAWindowClosedError extends AgentError {
  constructor(message = 'WhatsApp 24hr customer service window is closed') {
    super('WA_WINDOW_CLOSED', message);
  }
}
