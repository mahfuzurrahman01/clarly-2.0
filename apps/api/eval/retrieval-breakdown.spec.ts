// P0.3: the phase table is the evidence a retrieval optimisation gets chosen
// on, so its arithmetic — especially "not measured" vs "measured as zero" —
// has to be right.
import { renderRetrievalBreakdown } from './retrieval-breakdown';
import type { RetrievalPhaseTimings } from '../src/modules/retrieval/retrieval-timings';
import type { TurnRecord } from './types';

function record(phases?: Partial<RetrievalPhaseTimings>): TurnRecord {
  return {
    corpus: 'test',
    question: 'q',
    expect: 'any',
    answer: '',
    escalated: false,
    escalationReason: null,
    escalationSource: null,
    confidence: 0.9,
    citedChunkIds: [],
    isHallucination: false,
    promptVersion: 'v1',
    latencyMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    retrievalMs: phases?.totalMs ?? 0,
    retrievalPhases: phases
      ? {
          embedMs: 0,
          vectorQueryMs: 0,
          lexicalQueryMs: 0,
          fusionMs: 0,
          storeMs: 0,
          rerankMs: 0,
          totalMs: 0,
          ...phases,
        }
      : undefined,
    retrievedChunkIds: [],
    retrievedScores: [],
    recallHit: null,
    deterministicPass: true,
    deterministicFailures: [],
    toolCalls: [],
  };
}

describe('renderRetrievalBreakdown()', () => {
  it('attributes the dominant share to the phase that actually dominates', () => {
    const records = [
      record({ embedMs: 300, embedHttpTtfbMs: 285, storeMs: 12, totalMs: 312 }),
      record({ embedMs: 320, embedHttpTtfbMs: 300, storeMs: 10, totalMs: 330 }),
    ];

    const output = renderRetrievalBreakdown(records).join('\n');

    expect(output).toContain('query embed (remote HTTP)');
    // p95 of the two-sample embed set is 320 against a total p95 of 330 —
    // ~97%, which is the finding this table exists to make unmissable.
    expect(output).toMatch(
      /query embed \(remote HTTP\) \| 300ms \| 320ms \| 97%/,
    );
  });

  it('renders a phase that ran but took no time as 0ms, not as blank', () => {
    // Rerank off (D4's per-tenant flag): 0ms is a measurement, not a gap.
    const output = renderRetrievalBreakdown([
      record({ embedMs: 100, rerankMs: 0, totalMs: 110 }),
    ]).join('\n');

    expect(output).toMatch(/\| rerank \| 0ms \| 0ms \|/);
  });

  it('renders an unmeasured optional phase as a dash', () => {
    // An Embedder that reports no HTTP split must not be recorded as 0ms —
    // that would read as "the network is free".
    const output = renderRetrievalBreakdown([
      record({ embedMs: 100, totalMs: 110 }),
    ]).join('\n');

    expect(output).toMatch(/to response headers \| — \| — \| — \|/);
  });

  it('explains itself instead of printing an empty table when nothing was measured', () => {
    const output = renderRetrievalBreakdown([record(), record()]).join('\n');

    expect(output).toContain('No phase timings recorded');
    expect(output).not.toContain('| Phase |');
  });

  it('counts only the turns that carried timings', () => {
    const output = renderRetrievalBreakdown([
      record({ totalMs: 100 }),
      record(),
    ]).join('\n');

    expect(output).toContain('(n=1 turns)');
  });
});
