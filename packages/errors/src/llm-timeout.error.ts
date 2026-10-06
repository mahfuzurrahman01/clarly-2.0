import { AgentError } from './agent-error';

/** LLM provider call exceeded the deadline. Owner: T1/A0 (feeds the D2 circuit breaker). */
export class LLMTimeout extends AgentError {
  constructor(message = 'LLM provider call timed out') {
    super('LLM_TIMEOUT', message);
  }
}
