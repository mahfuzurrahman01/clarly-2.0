/**
 * Base class for every named exception in the T1 error/rescue registry
 * (see BACKEND_PLAN.md T1). Rescue-action policy (retry/backoff/escalate per
 * class) lives in `./rescue-policy.ts`, keyed by `.code` — look it up via
 * `getRescuePolicy(error.code)`, don't branch on `instanceof` per class.
 */
export abstract class AgentError extends Error {
  /** Stable machine-readable identifier, distinct from the human message. */
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
