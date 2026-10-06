import { AgentRunTelemetry } from './agent-run-telemetry';
import { recordRetrievalSubSpans } from './retrieval-sub-spans';
import { emptyRetrievalPhaseTimings } from '../retrieval/retrieval-timings';

describe('recordRetrievalSubSpans()', () => {
  it('maps every measured retrieval phase onto its agent_runs.spans key', () => {
    const telemetry = new AgentRunTelemetry();

    recordRetrievalSubSpans(telemetry, {
      embedMs: 300,
      embedHttpTtfbMs: 280,
      embedHttpBodyMs: 15,
      vectorQueryMs: 6,
      lexicalQueryMs: 2,
      fusionMs: 1,
      storeMs: 12,
      rerankMs: 40,
      totalMs: 352,
    });

    expect(telemetry.spans).toEqual({
      retrievalEmbedMs: 300,
      retrievalEmbedHttpTtfbMs: 280,
      retrievalVectorQueryMs: 6,
      retrievalLexicalQueryMs: 2,
      retrievalFusionMs: 1,
      retrievalRerankMs: 40,
    });
  });

  // The point of the whole exercise: a row must let a reader say "the remote
  // embed call was the problem" without re-running anything.
  it('leaves the aggregate retrievalMs span for the caller to record', () => {
    const telemetry = new AgentRunTelemetry();
    telemetry.addSpan('retrievalMs', 352);

    recordRetrievalSubSpans(telemetry, {
      ...emptyRetrievalPhaseTimings(),
      embedMs: 300,
    });

    expect(telemetry.spans.retrievalMs).toBe(352);
    expect(telemetry.spans.retrievalEmbedMs).toBe(300);
  });

  it('omits phases that did not run rather than recording them as 0ms', () => {
    const telemetry = new AgentRunTelemetry();

    // Rerank off (D4's per-tenant flag) and an Embedder with no HTTP split.
    recordRetrievalSubSpans(telemetry, {
      ...emptyRetrievalPhaseTimings(),
      embedMs: 300,
      vectorQueryMs: 6,
    });

    expect(telemetry.spans).toEqual({
      retrievalEmbedMs: 300,
      retrievalVectorQueryMs: 6,
    });
  });

  it('is a no-op when the retrieval result carries no timings at all', () => {
    const telemetry = new AgentRunTelemetry();

    recordRetrievalSubSpans(telemetry, undefined);

    expect(telemetry.spans).toEqual({});
  });
});
