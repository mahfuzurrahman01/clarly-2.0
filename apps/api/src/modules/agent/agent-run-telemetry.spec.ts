import { AgentRunTelemetry } from './agent-run-telemetry';

describe('AgentRunTelemetry', () => {
  it('sums token usage across multiple addUsage() calls (initial + tool round-trips + retries)', () => {
    const telemetry = new AgentRunTelemetry();

    telemetry.addUsage({ inputTokens: 100, outputTokens: 20 });
    telemetry.addUsage({ inputTokens: 150, outputTokens: 30 });

    expect(telemetry.inputTokens).toBe(250);
    expect(telemetry.outputTokens).toBe(50);
  });

  it('sums span durations across multiple addSpan() calls for the same span name', () => {
    const telemetry = new AgentRunTelemetry();

    telemetry.addSpan('llmMs', 120);
    telemetry.addSpan('llmMs', 80);
    telemetry.addSpan('retrievalMs', 40);

    expect(telemetry.spans).toEqual({ llmMs: 200, retrievalMs: 40 });
  });

  it('omits a span entirely from the snapshot when it never accumulated any time (never ran this turn)', () => {
    const telemetry = new AgentRunTelemetry();

    telemetry.addSpan('retrievalMs', 10);

    expect(telemetry.spans).toEqual({ retrievalMs: 10 });
    expect(telemetry.spans.llmMs).toBeUndefined();
    expect(telemetry.spans.toolExecutionMs).toBeUndefined();
    expect(telemetry.spans.guardrailMs).toBeUndefined();
  });

  it('starts at zero token usage with no prior addUsage() calls', () => {
    const telemetry = new AgentRunTelemetry();

    expect(telemetry.inputTokens).toBe(0);
    expect(telemetry.outputTokens).toBe(0);
    expect(telemetry.spans).toEqual({});
  });
});
