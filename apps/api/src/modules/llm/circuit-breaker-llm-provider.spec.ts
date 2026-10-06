import { LLMRefusal, LLMTimeout } from '@repo/errors';
import type { AppConfigService } from '../core';
import type { Clock } from '../core/clock/clock';
import { CircuitBreakerLlmProvider } from './circuit-breaker-llm-provider';
import type { GeminiProvider } from './gemini.provider';

function makeConfig(
  overrides: Partial<{ threshold: number; resetMs: number }> = {},
): AppConfigService {
  return {
    llmBreakerFailureThreshold: overrides.threshold ?? 3,
    llmBreakerResetMs: overrides.resetMs ?? 10000,
  } as unknown as AppConfigService;
}

function makeClock(startMs = 0): Clock & { advance: (ms: number) => void } {
  let currentMs = startMs;
  return {
    now: () => new Date(currentMs),
    nowMs: () => currentMs,
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('CircuitBreakerLlmProvider', () => {
  it('passes calls through to the inner provider while closed', async () => {
    const inner = {
      complete: jest.fn().mockResolvedValue({ content: 'ok' }),
    } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig(),
      makeClock(),
    );

    await expect(breaker.complete(REQUEST)).resolves.toEqual({ content: 'ok' });
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after N consecutive breaker-counted failures (LLMTimeout) and skips the network on the next call', async () => {
    const completeMock = jest.fn().mockRejectedValue(new LLMTimeout());
    const inner = { complete: completeMock } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 3 }),
      makeClock(),
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('closed');
    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('open');

    completeMock.mockClear();
    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('D2: escalation_reason is LLM_ERROR when the breaker is open (RESCUE_POLICY.LLM_TIMEOUT)', async () => {
    const inner = {
      complete: jest.fn().mockRejectedValue(new LLMTimeout()),
    } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 1 }),
      makeClock(),
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('open');

    await expect(breaker.complete(REQUEST)).rejects.toBeInstanceOf(LLMTimeout);
  });

  it('does not open the breaker for a non-breaker-counted error (LLMRefusal)', async () => {
    const inner = {
      complete: jest.fn().mockRejectedValue(new LLMRefusal()),
    } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 1 }),
      makeClock(),
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMRefusal);
    expect(breaker.getState()).toBe('closed');
  });

  it('a success resets the consecutive-failure count', async () => {
    const inner = {
      complete: jest
        .fn()
        .mockRejectedValueOnce(new LLMTimeout())
        .mockRejectedValueOnce(new LLMTimeout())
        .mockResolvedValueOnce({ content: 'ok' })
        .mockRejectedValueOnce(new LLMTimeout())
        .mockRejectedValueOnce(new LLMTimeout()),
    } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 3 }),
      makeClock(),
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    await expect(breaker.complete(REQUEST)).resolves.toEqual({ content: 'ok' });
    expect(breaker.getState()).toBe('closed');
    // Two more failures after the reset — still below threshold (3).
    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('closed');
  });

  it('transitions open -> half-open after the reset window, and a successful trial call closes it', async () => {
    const inner = {
      complete: jest
        .fn()
        .mockRejectedValueOnce(new LLMTimeout())
        .mockResolvedValueOnce({ content: 'ok' }),
    } as unknown as GeminiProvider;
    const clock = makeClock();
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 1, resetMs: 5000 }),
      clock,
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('open');

    clock.advance(5000);
    expect(breaker.getState()).toBe('half-open');

    await expect(breaker.complete(REQUEST)).resolves.toEqual({ content: 'ok' });
    expect(breaker.getState()).toBe('closed');
  });

  it('a failed half-open trial call re-opens the breaker immediately (not waiting for the full threshold again)', async () => {
    const inner = {
      complete: jest.fn().mockRejectedValue(new LLMTimeout()),
    } as unknown as GeminiProvider;
    const clock = makeClock();
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 5, resetMs: 1000 }),
      clock,
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('closed'); // only 1 of 5 failures so far

    // Force it open via enough failures, then let it reset to half-open.
    await breaker.complete(REQUEST).catch(() => undefined);
    await breaker.complete(REQUEST).catch(() => undefined);
    await breaker.complete(REQUEST).catch(() => undefined);
    await breaker.complete(REQUEST).catch(() => undefined);
    expect(breaker.getState()).toBe('open');

    clock.advance(1000);
    expect(breaker.getState()).toBe('half-open');

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('open');
  });

  it('countTokens() is never breaker-gated, even while open', async () => {
    const inner = {
      complete: jest.fn().mockRejectedValue(new LLMTimeout()),
      countTokens: jest.fn().mockResolvedValue(42),
    } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 1 }),
      makeClock(),
    );

    await expect(breaker.complete(REQUEST)).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('open');

    await expect(breaker.countTokens({ messages: [] })).resolves.toBe(42);
  });

  it('completeWithTools() is also breaker-gated', async () => {
    const inner = {
      completeWithTools: jest.fn().mockRejectedValue(new LLMTimeout()),
    } as unknown as GeminiProvider;
    const breaker = new CircuitBreakerLlmProvider(
      inner,
      makeConfig({ threshold: 1 }),
      makeClock(),
    );

    await expect(
      breaker.completeWithTools({ ...REQUEST, tools: [] }),
    ).rejects.toThrow(LLMTimeout);
    expect(breaker.getState()).toBe('open');
  });
});
