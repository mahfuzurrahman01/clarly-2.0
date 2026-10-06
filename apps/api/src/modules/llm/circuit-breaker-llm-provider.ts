// A0/D2: SPOF containment. Wraps the concrete provider (GeminiProvider,
// the only adapter this pass) and decorates every call with breaker state.
// "After N consecutive LLMTimeout/5xx, breaker opens and the respond path
// skips the LLM entirely" — implemented here as: while open, every call
// throws LLMTimeout immediately, without touching the network, which
// RESCUE_POLICY.LLM_TIMEOUT already maps to `escalationReason: 'LLM_ERROR'`
// — exactly D2's "creates a ticket with escalation_reason = LLM_ERROR".
//
// This is the ONLY class bound to the `LlmProvider` DI token (see
// llm.module.ts) — callers never see GeminiProvider directly, so the
// breaker can't accidentally be bypassed by an injection mistake elsewhere.
import { Injectable } from '@nestjs/common';
import { AgentError, LLMTimeout, getRescuePolicy } from '@repo/errors';
import { AppConfigService } from '../core';
import { Clock } from '../core/clock/clock';
import {
  LlmProvider,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmCountTokensInput,
  type LlmToolRequest,
  type LlmToolResult,
} from './ports/llm-provider.port';

type BreakerState = 'closed' | 'open' | 'half-open';

@Injectable()
export class CircuitBreakerLlmProvider extends LlmProvider {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMs = 0;

  constructor(
    // Widened from GeminiProvider to the port when A11 added a second wrapped
    // binding (the vision provider) — the breaker never depended on anything
    // vendor-specific, only on the port.
    private readonly inner: LlmProvider,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Exposed for observability (T18 alerting on "breaker open") without leaking internal timing fields. */
  getState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    return this.callThrough(() => this.inner.complete(request));
  }

  completeWithTools(request: LlmToolRequest): Promise<LlmToolResult> {
    return this.callThrough(() => this.inner.completeWithTools(request));
  }

  countTokens(input: LlmCountTokensInput): Promise<number> {
    // Local approximation, no network call — not breaker-gated.
    return this.inner.countTokens(input);
  }

  /**
   * A11: delegated, never defaulted. The breaker is the only thing bound to a
   * provider token, so answering the base class's `false` here would make every
   * vision binding look text-only and silently strip images off the turn.
   */
  override supportsVision(): boolean {
    return this.inner.supportsVision();
  }

  private async callThrough<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new LLMTimeout(
        'LLM circuit breaker is open — skipping provider call',
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private maybeHalfOpen(): void {
    if (
      this.state === 'open' &&
      this.clock.nowMs() - this.openedAtMs >= this.config.llmBreakerResetMs
    ) {
      this.state = 'half-open';
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  private onFailure(error: unknown): void {
    if (!countsTowardBreaker(error)) return;

    this.consecutiveFailures += 1;
    // A half-open trial call that fails re-opens immediately, without
    // waiting for the full threshold again — the trial already answered
    // "did it recover?" with a no.
    if (
      this.state === 'half-open' ||
      this.consecutiveFailures >= this.config.llmBreakerFailureThreshold
    ) {
      this.state = 'open';
      this.openedAtMs = this.clock.nowMs();
      this.consecutiveFailures = 0;
    }
  }
}

function countsTowardBreaker(error: unknown): boolean {
  if (!(error instanceof AgentError)) return false;
  try {
    return getRescuePolicy(error.code).countsTowardBreaker;
  } catch {
    // Unregistered code — fail closed (don't let an unknown error type
    // silently open the breaker), a T1 registry gap should surface as a
    // test failure (rescue-policy.spec.ts), not breaker flapping.
    return false;
  }
}
