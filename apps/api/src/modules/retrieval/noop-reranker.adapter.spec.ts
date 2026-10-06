import { NoopRerankerAdapter } from './noop-reranker.adapter';

describe('NoopRerankerAdapter.rerank()', () => {
  it('preserves input order and truncates to topN', async () => {
    const adapter = new NoopRerankerAdapter();
    const candidates = [
      { id: 'a', content: 'a' },
      { id: 'b', content: 'b' },
      { id: 'c', content: 'c' },
    ];

    const result = await adapter.rerank('query', candidates, 2);

    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it("scores are normalized to (0, 1], descending, matching Cohere's scale", async () => {
    const adapter = new NoopRerankerAdapter();
    const candidates = [
      { id: 'a', content: 'a' },
      { id: 'b', content: 'b' },
    ];

    const result = await adapter.rerank('query', candidates, 2);

    expect(result[0].score).toBeGreaterThan(0);
    expect(result[0].score).toBeLessThanOrEqual(1);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('handles an empty candidate list', async () => {
    const adapter = new NoopRerankerAdapter();

    await expect(adapter.rerank('query', [], 5)).resolves.toEqual([]);
  });
});
