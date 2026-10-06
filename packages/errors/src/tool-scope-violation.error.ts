import { AgentError } from './agent-error';

/**
 * A tool call was attempted outside the calling tenant's allowlisted scope.
 * Security-critical (T2) — never leak error detail to the attacker-facing
 * side of this exception.
 */
export class ToolScopeViolation extends AgentError {
  constructor(message = 'Tool call is outside the tenant scope') {
    super('TOOL_SCOPE_VIOLATION', message);
  }
}
