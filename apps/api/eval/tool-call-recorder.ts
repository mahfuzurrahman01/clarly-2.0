/**
 * L2: captures every tool call a turn makes, at the SAME authorize()/
 * execute() call site AgentRuntime itself uses (agent-runtime.ts's
 * `handleToolRoundTrip`) — never re-derived from the model's answer text or
 * from a separate mock. The harness runs the real `ToolExecutionService`
 * singleton (`app.get(ToolExecutionService)`); this wraps that ONE instance's
 * two methods so every real call, from every tool, is observed without
 * touching src/.
 *
 * Round-trip attribution: AgentRuntime's own `toolRoundTrips` counter is not
 * observable from outside the loop, so this recorder infers the boundary the
 * same way the loop advances it — every completed BURST of authorize()+
 * execute() calls that happens between two calls to `beginTurn()`/`nextRoundTrip()`
 * shares an index. The runner calls `nextRoundTrip()` once per LLM
 * `completeWithTools` invocation by also wrapping the turn's provider (see
 * `wrapProviderForRoundTrips`), which is exactly the event that starts a new
 * round trip in `agent-runtime.ts`.
 */
import type { ToolExecutionContext } from '../src/modules/tool-execution/tool-execution-context';
import type { ToolExecutionService } from '../src/modules/tool-execution/tool-execution.service';
import type {
  LlmProvider,
  LlmToolRequest,
  LlmToolResult,
} from '../src/modules/llm/ports/llm-provider.port';
import type { ToolCallRecord } from './types';

export class ToolCallRecorder {
  private calls: ToolCallRecord[] = [];
  private roundTripIndex = -1;
  private pendingErrors = new Map<string, string>();

  /** Called once per turn, before `agent.respond()` runs. */
  beginTurn(): void {
    this.calls = [];
    this.roundTripIndex = -1;
  }

  /** Called once per LLM completion the turn's provider makes — the same event that starts a new tool round trip in AgentRuntime.runLoop(). */
  nextRoundTrip(): void {
    this.roundTripIndex += 1;
  }

  record(name: string, args: Record<string, unknown>, result: unknown): void {
    this.calls.push({
      name,
      args,
      result,
      roundTripIndex: Math.max(this.roundTripIndex, 0),
      error: this.pendingErrors.get(name),
      executed: true,
    });
  }

  recordAuthorizeFailure(name: string, error: unknown): void {
    // authorize() threw before execute() could run (ToolScopeViolation on a
    // forbidTools probe, or a malformed-args corrective retry). Still a real
    // attempt to call the tool, which is exactly what forbidTools/expectTools
    // need to see — a blocked attempt is not the same as no attempt.
    this.calls.push({
      name,
      args: {},
      result: null,
      roundTripIndex: Math.max(this.roundTripIndex, 0),
      error: error instanceof Error ? error.message : String(error),
      // H3a: the tool never ran — scoring counts this as an attempt, not a
      // violation, so a refused probe is not reported as a real forbidden call.
      executed: false,
    });
  }

  turnToolCalls(): ToolCallRecord[] {
    return this.calls;
  }
}

/**
 * Wraps the SHARED `ToolExecutionService` singleton's `authorize`/`execute`
 * so every call any turn makes is captured by the recorder that is "current"
 * at call time. Returns an unwrap function.
 *
 * Safe for the eval harness's sequential-per-case execution model (one
 * `agent.respond()` in flight at a time — see runner.ts's case loop, which
 * awaits each case before starting the next): the recorder is swapped via
 * `setCurrent()` immediately before each turn, so nothing here needs to
 * thread a request-scoped context through a shared NestJS singleton, which
 * `ToolExecutionService` deliberately is not (see its own file header).
 */
type AuthorizeFn = (
  ctx: ToolExecutionContext,
  toolName: string,
  args: unknown,
) => Promise<Record<string, unknown>>;
type ExecuteFn = (
  ctx: ToolExecutionContext,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export function instrumentToolExecution(service: ToolExecutionService): {
  setCurrent: (recorder: ToolCallRecorder | null) => void;
  restore: () => void;
} {
  let current: ToolCallRecorder | null = null;
  // `.bind()` snapshots BOTH the function reference and its `this` in one
  // step, evaluated now — before either is reassigned below, so this can
  // never call back into the wrapper it is about to become part of. TS's
  // `bind()` overload does not carry a 3-argument method's real signature
  // through, so the result is asserted back to it explicitly rather than
  // left as the `any` that produces (never an implicit/unchecked cast: the
  // shape is exactly `service.authorize`'s own declared signature).
  const originalAuthorize = service.authorize.bind(service) as AuthorizeFn;
  const originalExecute = service.execute.bind(service) as ExecuteFn;

  const authorize: AuthorizeFn = async (ctx, toolName, args) => {
    try {
      return await originalAuthorize(ctx, toolName, args);
    } catch (error) {
      current?.recordAuthorizeFailure(toolName, error);
      throw error;
    }
  };

  const execute: ExecuteFn = async (ctx, toolName, args) => {
    const result = await originalExecute(ctx, toolName, args);
    current?.record(toolName, args, result);
    return result;
  };

  service.authorize = authorize;
  service.execute = execute;

  return {
    setCurrent: (recorder) => {
      current = recorder;
    },
    restore: () => {
      service.authorize = originalAuthorize;
      service.execute = originalExecute;
    },
  };
}

/**
 * Wraps the turn's chat `LlmProvider` so every `completeWithTools` call
 * advances the recorder's round-trip counter BEFORE the call runs — matching
 * `agent-runtime.ts`: a fresh round trip starts every time the loop asks the
 * model again, and any tool calls the model returns from THIS completion
 * belong to the round trip that is now current.
 */
type CompleteWithToolsFn = (request: LlmToolRequest) => Promise<LlmToolResult>;

export function wrapProviderForRoundTrips(
  provider: LlmProvider,
  getCurrent: () => ToolCallRecorder | null,
): () => void {
  // See instrumentToolExecution()'s own comment on the `.bind()` + assertion
  // pattern used here.
  const original = provider.completeWithTools.bind(
    provider,
  ) as CompleteWithToolsFn;
  const wrapped: CompleteWithToolsFn = (request) => {
    getCurrent()?.nextRoundTrip();
    return original(request);
  };
  provider.completeWithTools = wrapped;
  return () => {
    provider.completeWithTools = original;
  };
}
