import { AgentError } from './agent-error';

/** BSP/Meta rejected a template message (D9 24hr-window fallback). Owner: T1/T0. */
export class WATemplateRejected extends AgentError {
  constructor(message = 'WhatsApp template message was rejected') {
    super('WA_TEMPLATE_REJECTED', message);
  }
}
