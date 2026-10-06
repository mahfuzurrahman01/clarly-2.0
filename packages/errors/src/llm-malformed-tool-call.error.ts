import { AgentError } from './agent-error';

/** LLM returned a tool call that fails schema validation. Owner: T1/A4. */
export class LLMMalformedToolCall extends AgentError {
  constructor(message = 'LLM returned a malformed tool call') {
    super('LLM_MALFORMED_TOOL_CALL', message);
  }
}
