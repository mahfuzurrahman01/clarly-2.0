import type { AppConfigService } from '../core';
import { CohereRerankerAdapter } from './cohere-reranker.adapter';

function makeConfig(): AppConfigService {
  return {
    cohereApiKey: 'test-cohere-key',
    rerankTimeoutMs: 1500,
  } as unknown as AppConfigService;
}

const CANDIDATES = [
  { id: 'chunk-1', content: 'Refunds take 5 days.' },
  { id: 'chunk-2', content: 'Shipping takes 3-5 days.' },
];

describe('CohereRerankerAdapter.rerank()', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('maps Cohere response indices back to candidate IDs, in the returned order', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.4 },
          ],
        }),
    });
    const adapter = new CohereRerankerAdapter(makeConfig());

    const result = await adapter.rerank('shipping time', CANDIDATES, 5);

    expect(result).toEqual([
      { id: 'chunk-2', score: 0.9 },
      { id: 'chunk-1', score: 0.4 },
    ]);
  });

  it('sends the API key, model, query, and documents in the request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    const adapter = new CohereRerankerAdapter(makeConfig());

    await adapter.rerank('shipping time', CANDIDATES, 5);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cohere.com/v2/rerank');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-cohere-key',
    );

    const body = JSON.parse(init.body as string) as {
      query: string;
      documents: string[];
      top_n: number;
    };
    expect(body.query).toBe('shipping time');
    expect(body.documents).toEqual([
      'Refunds take 5 days.',
      'Shipping takes 3-5 days.',
    ]);
    expect(body.top_n).toBe(2);
  });

  it('returns an empty array without calling fetch for an empty candidate list', async () => {
    const adapter = new CohereRerankerAdapter(makeConfig());

    const result = await adapter.rerank('query', [], 5);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the response body when Cohere returns a non-2xx status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('unauthorized'),
    });
    const adapter = new CohereRerankerAdapter(makeConfig());

    await expect(adapter.rerank('query', CANDIDATES, 5)).rejects.toThrow(/401/);
  });

  it('throws on an out-of-range document index in the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ results: [{ index: 99, relevance_score: 0.5 }] }),
    });
    const adapter = new CohereRerankerAdapter(makeConfig());

    await expect(adapter.rerank('query', CANDIDATES, 5)).rejects.toThrow(
      /out-of-range/,
    );
  });

  it('bounds the request with an abort signal (RERANK_TIMEOUT_MS)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    const adapter = new CohereRerankerAdapter(makeConfig());

    await adapter.rerank('query', CANDIDATES, 5);

    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
    timeoutSpy.mockRestore();
  });

  it('names the timeout when the signal fires, so the caller can degrade and log it', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });
    fetchMock.mockRejectedValue(timeout);
    const adapter = new CohereRerankerAdapter(makeConfig());

    await expect(adapter.rerank('query', CANDIDATES, 5)).rejects.toThrow(
      'Cohere rerank timed out after 1500ms (RERANK_TIMEOUT_MS)',
    );
  });

  it('rethrows any other fetch failure unchanged', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const adapter = new CohereRerankerAdapter(makeConfig());

    await expect(adapter.rerank('query', CANDIDATES, 5)).rejects.toThrow(
      'ECONNRESET',
    );
  });
});
