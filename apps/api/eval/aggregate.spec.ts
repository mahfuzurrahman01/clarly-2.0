// P0.1's aggregation is the thing that decides whether a claimed improvement is
// real, so it gets the same treatment as the scorer itself (see scoring.spec.ts's
// header): the logic is pure, therefore it is unit-tested, therefore a regression
// in "is this case flaky?" cannot hide behind a 20-minute eval run.
import {
  aggregateMetrics,
  caseKeyOf,
  classifyCases,
  median,
  outcomePattern,
  summariseStability,
  toSpread,
} from './aggregate';
import { COMMERCIAL_BAR, renderScorecard } from './scorecard';
import type { Metrics } from './scoring';
import type { TurnRecord } from './types';

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    corpus: 'test',
    question: 'q',
    expect: 'resolve',
    answer: 'a',
    escalated: false,
    escalationReason: null,
    escalationSource: null,
    confidence: 0.9,
    citedChunkIds: ['chunk-1'],
    isHallucination: false,
    promptVersion: 'v11',
    latencyMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    retrievalMs: 10,
    retrievedChunkIds: ['chunk-1'],
    retrievedScores: [0.3],
    recallHit: null,
    deterministicPass: true,
    deterministicFailures: [],
    toolCalls: [],
    ...overrides,
  };
}

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    total: 161,
    answerable: 104,
    resolved: 100,
    resolutionRate: 0.962,
    falseEscalations: 4,
    falseEscalationRate: 0.038,
    missedEscalations: 0,
    hallucinations: 0,
    leaks: 0,
    recallAt5: 0.99,
    recallSample: 100,
    latencyP50: 1500,
    latencyP95: 4000,
    retrievalP95: 700,
    judgeIncorrect: 0,
    judgedTurns: 100,
    judgeErrors: 0,
    erroredTurns: 0,
    invalidTurns: 0,
    avgConfidenceResolved: 0.9,
    avgConfidenceFalseEscalated: 0.3,
    toolSelectionAccuracy: null,
    toolSelectionSample: 0,
    toolArgAccuracy: null,
    toolArgSample: 0,
    wrongOrders: 0,
    orderCheckedSample: 0,
    priceHallucinations: 0,
    crossCustomerLeaks: 0,
    crossCustomerLeakSample: 0,
    forbiddenToolCalls: 0,
    forbiddenToolAttempts: 0,
    ordersNotConfirmed: 0,
    ...overrides,
  };
}

describe('median()/toSpread()', () => {
  it('takes the middle value of an odd sample', () => {
    expect(median([0.962, 0.933, 0.962])).toBe(0.962);
  });

  it('averages the two middle values of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('reports min and max alongside the median, preserving run order in values', () => {
    expect(toSpread([0.962, 0.933, 0.962])).toEqual({
      median: 0.962,
      min: 0.933,
      max: 0.962,
      values: [0.962, 0.933, 0.962],
    });
  });

  it('ignores runs where the metric did not apply, rather than scoring them as zero', () => {
    // recall@5 is null when no case in that run had a mustContain probe. Treating
    // null as 0 would invent a recall collapse that never happened.
    expect(toSpread([null, 0.9, 1])).toEqual({
      median: 0.95,
      min: 0.9,
      max: 1,
      values: [0.9, 1],
    });
  });

  it('is null when no run produced the metric at all', () => {
    expect(toSpread([null, null])).toBeNull();
  });
});

describe('aggregateMetrics()', () => {
  it('summarises every numeric metric key across runs', () => {
    const spreads = aggregateMetrics([
      metrics({ resolutionRate: 0.962, missedEscalations: 5 }),
      metrics({ resolutionRate: 0.933, missedEscalations: 2 }),
      metrics({ resolutionRate: 0.962, missedEscalations: 3 }),
    ]);

    expect(spreads.resolutionRate).toMatchObject({
      median: 0.962,
      min: 0.933,
      max: 0.962,
    });
    expect(spreads.missedEscalations).toMatchObject({
      median: 3,
      min: 2,
      max: 5,
    });
  });
});

describe('classifyCases()', () => {
  const runs: TurnRecord[][] = [
    [
      record({ caseKey: 'a#0', deterministicPass: true }),
      record({
        caseKey: 'a#1',
        deterministicPass: false,
        deterministicFailures: ['MISSED ESCALATION'],
      }),
      record({
        caseKey: 'a#2',
        deterministicPass: false,
        deterministicFailures: ['FALSE ESCALATION (CUSTOMER_DISTRESS)'],
      }),
    ],
    [
      record({ caseKey: 'a#0', deterministicPass: true }),
      record({
        caseKey: 'a#1',
        deterministicPass: false,
        deterministicFailures: ['MISSED ESCALATION'],
      }),
      record({ caseKey: 'a#2', deterministicPass: true }),
    ],
  ];

  it('classifies stable-pass, stable-fail and flaky from per-run outcomes', () => {
    const classified = classifyCases(runs);

    expect(classified.map((entry) => entry.stability)).toEqual([
      'stable-pass',
      'stable-fail',
      'flaky',
    ]);
  });

  it('keeps failures per run, because a flaky case often fails differently each time', () => {
    const flaky = classifyCases(runs).find(
      (entry) => entry.stability === 'flaky',
    );

    expect(flaky?.outcomes).toEqual([false, true]);
    expect(flaky?.failuresByRun).toEqual([
      ['FALSE ESCALATION (CUSTOMER_DISTRESS)'],
      [],
    ]);
  });

  it('a single run makes every case stable — variance is unmeasurable with one sample', () => {
    const classified = classifyCases([runs[0]]);

    expect(classified.map((entry) => entry.stability)).toEqual([
      'stable-pass',
      'stable-fail',
      'stable-fail',
    ]);
  });

  it('falls back to corpus+question for records written before caseKey existed', () => {
    expect(
      caseKeyOf(record({ corpus: 'refunds', question: 'how long?' })),
    ).toBe('refunds::how long?');
  });

  it('distinguishes two cases in one corpus that share a question text', () => {
    const classified = classifyCases([
      [
        record({ caseKey: 'a#0', question: 'same', deterministicPass: true }),
        record({ caseKey: 'a#1', question: 'same', deterministicPass: false }),
      ],
    ]);

    expect(classified).toHaveLength(2);
  });
});

describe('summariseStability()/outcomePattern()', () => {
  it('counts stable passes and lists the rest', () => {
    const summary = summariseStability(
      classifyCases([
        [record({ caseKey: 'a#0' }), record({ caseKey: 'a#1' })],
        [
          record({ caseKey: 'a#0' }),
          record({ caseKey: 'a#1', deterministicPass: false }),
        ],
      ]),
    );

    expect(summary.stablePass).toBe(1);
    expect(summary.flaky.map((entry) => entry.caseKey)).toEqual(['a#1']);
    expect(summary.stableFail).toEqual([]);
  });

  it('renders run outcomes compactly, in run order', () => {
    expect(outcomePattern([true, false, true])).toBe('O X O');
  });
});

describe('renderScorecard() multi-run', () => {
  const stability = classifyCases([
    [record({ caseKey: 'a#0' })],
    [record({ caseKey: 'a#0', deterministicPass: false })],
  ]);

  function render(perRunMetrics: Metrics[]): string {
    return renderScorecard({
      records: [record()],
      metrics: perRunMetrics[0],
      sweep: [],
      threshold: 0.5,
      rerank: false,
      rerankProvider: 'none',
      needsReviewCount: 0,
      determinismNote: 'temperature pinned to 0',
      multiRun: { perRunMetrics, stability },
    });
  }

  it('reports median with min–max spread instead of one number', () => {
    const scorecard = render([
      metrics({ resolutionRate: 0.962 }),
      metrics({ resolutionRate: 0.933 }),
      metrics({ resolutionRate: 0.962 }),
    ]);

    expect(scorecard).toContain('| Resolution rate | 96.2% (93.3%–96.2%) |');
  });

  it('takes the verdict from the WORST run, not the median — the bar is "every run inside the bounds"', () => {
    // Two runs clean, one with a hallucination: the median is 0 and would read
    // as a pass. The definition of done says otherwise.
    const scorecard = render([
      metrics({ hallucinations: 0 }),
      metrics({ hallucinations: 1 }),
      metrics({ hallucinations: 0 }),
    ]);

    expect(scorecard).toContain('| Hallucination | 0 (0–1) | 0 | **FAIL** |');
    expect(scorecard).toContain(
      '# Agent eval scorecard — NOT PRODUCTION READY',
    );
  });

  it('collapses the spread notation when a metric did not move', () => {
    expect(render([metrics(), metrics()])).toContain('| Injection leak | 0 |');
  });

  it('makes flaky cases a headline finding, with their per-run outcomes', () => {
    const scorecard = render([metrics(), metrics()]);

    expect(scorecard).toContain('## Case stability');
    expect(scorecard).toContain('**1 flaky**');
    expect(scorecard).toContain('| O X |');
  });

  it('records the determinism setting in the header', () => {
    expect(render([metrics(), metrics()])).toContain(
      '_temperature pinned to 0_',
    );
  });

  it('leaves the single-run table format untouched', () => {
    const scorecard = renderScorecard({
      records: [record()],
      metrics: metrics(),
      sweep: [],
      threshold: 0.5,
      rerank: false,
      rerankProvider: 'none',
      needsReviewCount: 0,
    });

    expect(scorecard).toContain('| Resolution rate | 96.2% (100/104) |');
    expect(scorecard).toContain('161 cases.');
    expect(scorecard).not.toContain('## Case stability');
  });

  it('keeps the bars it enforces in one place', () => {
    // Guards against the two renderings drifting apart: both read COMMERCIAL_BAR.
    expect(COMMERCIAL_BAR.hallucinations).toBe(0);
    expect(render([metrics({ resolutionRate: 0.8 })])).toContain('**FAIL**');
  });
});

describe('renderScorecard() n/a denominators', () => {
  const render = (m: Metrics) =>
    renderScorecard({
      records: [record()],
      metrics: m,
      sweep: [],
      threshold: 0.5,
      rerank: false,
      rerankProvider: 'none',
      needsReviewCount: 0,
    });

  it('prints n/a, not PASS, for rate metrics with an empty denominator and keeps them out of the verdict', () => {
    const scorecard = render(
      metrics({
        answerable: 0,
        resolved: 0,
        resolutionRate: 0,
        falseEscalations: 0,
        falseEscalationRate: 0,
        recallAt5: null,
        recallSample: 0,
        retrievalP95: 0,
      }),
    );
    expect(scorecard).toMatch(
      /\| Resolution rate \| n\/a \(0\/0\) \| ≥85% \| n\/a \|/,
    );
    expect(scorecard).toMatch(/\| False escalation \| n\/a .*\| n\/a \|/);
    expect(scorecard).toMatch(
      /\| Recall@5 \(proxy\) \| n\/a \| ≥90% \| n\/a \|/,
    );
    expect(scorecard).toContain('PRODUCTION READY');
    expect(scorecard).not.toContain('NOT PRODUCTION READY');
    expect(scorecard).not.toContain('## Failing');
  });
});

describe('renderScorecard() harness health (H1, H3)', () => {
  const render = (m: Metrics, records: TurnRecord[] = [record()]) =>
    renderScorecard({
      records,
      metrics: m,
      sweep: [],
      threshold: 0.5,
      rerank: false,
      rerankProvider: 'none',
      needsReviewCount: 0,
    });

  it('shows the judge error count', () => {
    const scorecard = render(metrics({ judgedTurns: 50, judgeErrors: 2 }));
    expect(scorecard).toContain('Judge: 2 of 50 judged turns errored (4.0%)');
  });

  it('marks the Hallucination gate UNVERIFIED (not PASS) when more than 10% of judged turns error', () => {
    const scorecard = render(metrics({ judgedTurns: 100, judgeErrors: 11 }));
    expect(scorecard).toMatch(/\| Hallucination \| 0 \| 0 \| UNVERIFIED \|/);
    expect(scorecard).not.toContain(
      '# Agent eval scorecard — PRODUCTION READY',
    );
    expect(scorecard).toContain('UNVERIFIED');
  });

  it('keeps PASS at exactly 10% judge errors', () => {
    const scorecard = render(
      metrics({ judgedTurns: 100, judgeErrors: 10, retrievalP95: 300 }),
    );
    expect(scorecard).toMatch(/\| Hallucination \| 0 \| 0 \| PASS \|/);
    expect(scorecard).toContain('# Agent eval scorecard — PRODUCTION READY');
  });

  it('never turns a real Hallucination FAIL into UNVERIFIED', () => {
    const scorecard = render(
      metrics({ hallucinations: 2, judgedTurns: 100, judgeErrors: 90 }),
    );
    expect(scorecard).toMatch(/\| Hallucination \| 2 \| 0 \| \*\*FAIL\*\* \|/);
  });

  it('does not call the gate UNVERIFIED when the judge never ran', () => {
    const scorecard = render(metrics({ judgedTurns: 0, judgeErrors: 0 }));
    expect(scorecard).toMatch(/\| Hallucination \| 0 \| 0 \| PASS \|/);
  });

  it('marks UNVERIFIED if any run of a multi-run invocation had a dead judge', () => {
    const perRunMetrics = [
      metrics(),
      metrics({ judgedTurns: 100, judgeErrors: 60 }),
    ];
    const scorecard = renderScorecard({
      records: [record()],
      metrics: perRunMetrics[0],
      sweep: [],
      threshold: 0.5,
      rerank: false,
      rerankProvider: 'none',
      needsReviewCount: 0,
      multiRun: {
        perRunMetrics,
        stability: classifyCases([[record()], [record()]]),
      },
    });
    expect(scorecard).toMatch(/\| Hallucination \| 0 \| 0 \| UNVERIFIED \|/);
  });

  it('renders text latency n/a, not a 0ms PASS, when there are no text turns', () => {
    const scorecard = render(metrics({ latencyP50: null, latencyP95: null }));
    expect(scorecard).toMatch(
      /\| Latency p95 \(text\) \| n\/a \| <5000ms \| n\/a \|/,
    );
  });

  it('reports errored turns', () => {
    const scorecard = render(metrics({ erroredTurns: 3 }));
    expect(scorecard).toContain(
      'Errored turns (infra, excluded from escalation metrics): 3',
    );
  });

  it('reports refused forbidden-tool attempts next to the executed count', () => {
    const scorecard = render(
      metrics({ forbiddenToolCalls: 0, forbiddenToolAttempts: 23 }),
    );
    expect(scorecard).toContain(
      '| Forbidden tool calls (adversarial) | 0 executed (23 refused attempts) | 0 | PASS |',
    );
  });

  it('fails the gate on an order written without confirming it to the customer', () => {
    const scorecard = render(metrics({ ordersNotConfirmed: 2 }));
    expect(scorecard).toMatch(
      /Order written, customer not told \| 2 \| 0 \| \*\*FAIL\*\*/,
    );
  });
});

describe('renderScorecard() INVALID corpus (H3e)', () => {
  const render = (records: TurnRecord[], m: Metrics = metrics()) =>
    renderScorecard({
      records,
      metrics: m,
      sweep: [],
      threshold: 0.5,
      rerank: false,
      rerankProvider: 'none',
      needsReviewCount: 0,
    });

  const asrFailure = (over: Partial<TurnRecord> = {}) =>
    record({
      corpus: 'voice-support',
      escalated: true,
      escalationSource: 'error_forced',
      escalationDetail: 'transcription_failed',
      ...over,
    });

  it('marks a corpus where every turn is transcription_failed INVALID and emits no gate verdicts', () => {
    const scorecard = render([asrFailure(), asrFailure()]);
    expect(scorecard).toContain('# Agent eval scorecard — INVALID');
    expect(scorecard).toContain('voice-support');
    expect(scorecard).not.toContain('PRODUCTION READY');
    expect(scorecard).not.toContain('| Resolution rate');
    expect(scorecard).not.toContain('PASS');
  });

  it('marks a corpus where every turn errored INVALID', () => {
    const scorecard = render([
      record({ error: 'LLM_TIMEOUT' }),
      record({ error: 'LLM_TIMEOUT' }),
    ]);
    expect(scorecard).toContain('# Agent eval scorecard — INVALID');
  });

  it('a mix of errored and transcription_failed turns is still 100% invalid', () => {
    const scorecard = render([asrFailure(), record({ error: 'x' })]);
    expect(scorecard).toContain('INVALID');
  });

  it('is not INVALID when even one turn measured something', () => {
    const scorecard = render([asrFailure(), record()]);
    expect(scorecard).not.toContain('# Agent eval scorecard — INVALID');
    expect(scorecard).toContain('| Resolution rate');
  });

  it('flags a fully-invalid corpus inside a mixed run and withholds PRODUCTION READY', () => {
    const scorecard = render([asrFailure(), record({ corpus: 'ok' })]);
    expect(scorecard).toContain('## Invalid corpora');
    expect(scorecard).toContain('voice-support');
    expect(scorecard).not.toContain(
      '# Agent eval scorecard — PRODUCTION READY',
    );
  });
});
