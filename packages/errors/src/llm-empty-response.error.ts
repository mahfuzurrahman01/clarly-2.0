import { AgentError } from './agent-error';

/** LLM returned no usable content. Owner: T1/A4. */
export class LLMEmptyResponse extends AgentError {
  constructor(message = 'LLM returned an empty response') {
    super('LLM_EMPTY_RESPONSE', message);
  }
}
