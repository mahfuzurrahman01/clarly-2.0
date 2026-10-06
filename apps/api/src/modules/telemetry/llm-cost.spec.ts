import { estimateCostUsd } from './llm-cost';

describe('estimateCostUsd()', () => {
  it('computes cost from real Gemini 3.5 Flash-Lite rates', () => {
    // 1M input tokens @ $0.30/1M + 1M output tokens @ $2.50/1M
    const cost = estimateCostUsd('gemini-3.5-flash-lite', 1_000_000, 1_000_000);

    expect(cost).toBeCloseTo(0.3 + 2.5, 6);
  });

  it('prices each model from its own rates, not one shared rate', () => {
    const lite = estimateCostUsd('gemini-3.5-flash-lite', 1_000_000, 0);
    const flash = estimateCostUsd('gemini-3.5-flash', 1_000_000, 0);

    expect(lite).toBeCloseTo(0.3, 6);
    expect(flash).toBeCloseTo(1.5, 6);
  });

  it('scales linearly with token count', () => {
    const cost = estimateCostUsd('gemini-3.5-flash-lite', 500_000, 0);

    expect(cost).toBeCloseTo(0.15, 6);
  });

  it('returns 0 for a model with no sourced pricing, rather than guessing', () => {
    const cost = estimateCostUsd('some-future-model', 1_000_000, 1_000_000);

    expect(cost).toBe(0);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCostUsd('gemini-3.5-flash-lite', 0, 0)).toBe(0);
  });
});
