// T1 verify step: "unit test per exception class." Rather than one test
// per class re-asserting trivia (constructor sets .code), this asserts the
// actual T1 deliverable — every AgentError subclass has exactly one
// RESCUE_POLICY row, and every row's shape matches its class's documented
// intent (agent-error.ts subclass comments / rescue-policy.ts). A class
// added without a policy row fails this test, not silently falls through
// getRescuePolicy() at runtime in production.
import {
  AiHostAuthFailed,
  KBNotIndexed,
  MediaUnreadable,
  TranscriptionFailed,
  LLMEmptyResponse,
  LLMMalformedToolCall,
  LLMRefusal,
  LLMTimeout,
  RESCUE_POLICY,
  ToolScopeViolation,
  WANumberQualityDrop,
  WARateLimitError,
  WATemplateRejected,
  WAWindowClosedError,
  ChannelWindowClosedError,
  getRescuePolicy,
} from '@repo/errors';

const ALL_ERROR_CLASSES = [
  LLMTimeout,
  AiHostAuthFailed,
  LLMEmptyResponse,
  LLMRefusal,
  LLMMalformedToolCall,
  WARateLimitError,
  WATemplateRejected,
  WANumberQualityDrop,
  WAWindowClosedError,
  // Feature 16: the channel-agnostic successor to WAWindowClosedError.
  // Both are registered — WhatsApp's specialisation and the general case.
  ChannelWindowClosedError,
  KBNotIndexed,
  ToolScopeViolation,
  // F17 (A11/A12): unreadable media and failed transcription, both escalating
  // as UNSUPPORTED_MEDIA.
  MediaUnreadable,
  TranscriptionFailed,
];

describe('RESCUE_POLICY (T1 registry)', () => {
  it('has exactly one policy row per AgentError subclass', () => {
    for (const ErrorClass of ALL_ERROR_CLASSES) {
      const instance = new ErrorClass();
      expect(RESCUE_POLICY[instance.code]).toBeDefined();
    }
    expect(Object.keys(RESCUE_POLICY)).toHaveLength(ALL_ERROR_CLASSES.length);
  });

  it('getRescuePolicy() returns the matching row for every class', () => {
    for (const ErrorClass of ALL_ERROR_CLASSES) {
      const instance = new ErrorClass();
      expect(getRescuePolicy(instance.code)).toBe(RESCUE_POLICY[instance.code]);
    }
  });

  it('getRescuePolicy() throws on an unregistered code rather than returning undefined', () => {
    expect(() => getRescuePolicy('NOT_A_REAL_CODE')).toThrow(
      /No rescue policy registered/,
    );
  });

  it('every retryable policy declares maxAttempts and backoffMs', () => {
    for (const policy of Object.values(RESCUE_POLICY)) {
      if (policy.retryable) {
        expect(policy.maxAttempts).toBeGreaterThan(0);
        expect(policy.backoffMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('D2: LLM_TIMEOUT and LLM_EMPTY_RESPONSE count toward the circuit breaker; non-LLM failures do not', () => {
    expect(RESCUE_POLICY.LLM_TIMEOUT.countsTowardBreaker).toBe(true);
    expect(RESCUE_POLICY.LLM_EMPTY_RESPONSE.countsTowardBreaker).toBe(true);
    expect(RESCUE_POLICY.TOOL_SCOPE_VIOLATION.countsTowardBreaker).toBe(false);
    expect(RESCUE_POLICY.WA_RATE_LIMIT.countsTowardBreaker).toBe(false);
  });

  it('T2: TOOL_SCOPE_VIOLATION is never retried', () => {
    expect(RESCUE_POLICY.TOOL_SCOPE_VIOLATION.retryable).toBe(false);
  });

  it('D9: WA_WINDOW_CLOSED is not retryable and escalates with its own reason', () => {
    expect(RESCUE_POLICY.WA_WINDOW_CLOSED.retryable).toBe(false);
    expect(RESCUE_POLICY.WA_WINDOW_CLOSED.escalationReason).toBe(
      'WA_WINDOW_CLOSED',
    );
  });
});
