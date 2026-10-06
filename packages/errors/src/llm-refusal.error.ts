import { AgentError } from './agent-error';

/** LLM declined to answer (safety/policy refusal). Owner: T1/A4. */
export class LLMRefusal extends AgentError {
  constructor(message = 'LLM refused to respond') {
    super('LLM_REFUSAL', message);
  }
}
