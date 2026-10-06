import type { AppConfigService } from '../core';
import { QwenEmbedder } from './qwen-embedder.adapter';

const DIMENSIONS = 1024;
const MAX_INPUT_TOKENS = 4096;

function makeConfig(
  overrides: Partial<Record<string, unknown>> = {},
): AppConfigService {
  return {
    embeddingBaseUrl: 'https://embed.example.com',
    embeddingModel: 'qwen-embed',
    embeddingDimensions: DIMENSIONS,
    embeddingMaxInputTokens: MAX_INPUT_TOKENS,
    ...overrides,
  } as unknown as AppConfigService;
}

function vec(fill = 0.1, length = DIMENSIONS): number[] {
  return Array.from({ length }, () => fill);
}

function mockFetch(response: unknown, ok = true, status = 200): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(response),
  });
  global.fetch = fn;
  return fn;
}

describe('QwenEmbedder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the embedding vector, model and version', async () => {
    mockFetch({ data: [{ index: 0, embedding: vec() }] });

    const result = await new QwenEmbedder(makeConfig()).embed('hello');

    expect(result.values).toHaveLength(DIMENSIONS);
    expect(result.embeddingModel).toBe('qwen-embed');
    // 'q1', not the Gemini adapter's 'g1' — the two vector spaces are not
    // comparable, so the version tag must distinguish them or a partial
    // re-embed would silently mix them in one index.
    expect(result.embeddingVersion).toBe('q1');
  });

  it('posts to the OpenAI-compatible /v1/embeddings path', async () => {
    const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

    await new QwenEmbedder(makeConfig()).embed('hello');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://embed.example.com/v1/embeddings');
  });

  it('does not send `dimensions` — the served model rejects it', async () => {
    // Verified against the live endpoint: passing `dimensions` returns HTTP
    // 400 "does not support Matryoshka embeddings". EMBEDDING_DIMENSIONS is
    // a validation target here, never a request parameter.
    const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

    await new QwenEmbedder(makeConfig()).embed('hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('dimensions');
    expect(body.model).toBe('qwen-embed');
  });

  it('always sends truncate_prompt_tokens so an over-long chunk clips instead of failing', async () => {
    // The model has a hard 4096-token ceiling and returns 400 on overflow,
    // which would fail a whole ingest batch rather than one chunk.
    const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

    await new QwenEmbedder(makeConfig()).embed('hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.truncate_prompt_tokens).toBe(MAX_INPUT_TOKENS);
  });

  it('strips a trailing slash from the configured base URL', async () => {
    const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

    await new QwenEmbedder(
      makeConfig({ embeddingBaseUrl: 'https://embed.example.com/' }),
    ).embed('hello');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://embed.example.com/v1/embeddings');
  });

  describe('embedBatch', () => {
    it('sends one request for the whole batch and preserves input order', async () => {
      const fetchMock = mockFetch({
        data: [
          { index: 0, embedding: vec(0.1) },
          { index: 1, embedding: vec(0.2) },
          { index: 2, embedding: vec(0.3) },
        ],
      });

      const results = await new QwenEmbedder(makeConfig()).embedBatch([
        'a',
        'b',
        'c',
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { input: string[] };
      expect(body.input).toEqual(['a', 'b', 'c']);
      expect(results.map((r) => r.values[0])).toEqual([0.1, 0.2, 0.3]);
    });

    it('reorders by `index` rather than trusting arrival order', async () => {
      // The OpenAI contract does not guarantee response ordering, and a
      // silently mis-paired chunk/vector is unrecoverable once written.
      mockFetch({
        data: [
          { index: 2, embedding: vec(0.3) },
          { index: 0, embedding: vec(0.1) },
          { index: 1, embedding: vec(0.2) },
        ],
      });

      const results = await new QwenEmbedder(makeConfig()).embedBatch([
        'a',
        'b',
        'c',
      ]);

      expect(results.map((r) => r.values[0])).toEqual([0.1, 0.2, 0.3]);
    });

    it('makes no request for an empty batch', async () => {
      const fetchMock = mockFetch({ data: [] });

      const results = await new QwenEmbedder(makeConfig()).embedBatch([]);

      expect(results).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when the response count does not match the input count', async () => {
      mockFetch({ data: [{ index: 0, embedding: vec() }] });

      await expect(
        new QwenEmbedder(makeConfig()).embedBatch(['a', 'b']),
      ).rejects.toThrow('returned 1 embeddings, expected 2');
    });
  });

  describe('failure modes', () => {
    it('throws on a non-OK response without echoing the body', async () => {
      mockFetch({ error: { message: 'boom' } }, false, 429);

      await expect(
        new QwenEmbedder(makeConfig()).embed('hello'),
      ).rejects.toThrow('vLLM embeddings API returned HTTP 429');
    });

    it('throws when the vector width disagrees with EMBEDDING_DIMENSIONS', async () => {
      // This model cannot truncate, so a mismatch is a config error, not
      // something to paper over — and Postgres would otherwise reject the
      // insert three layers down inside the ingest worker.
      mockFetch({ data: [{ index: 0, embedding: vec(0.1, 2560) }] });

      await expect(
        new QwenEmbedder(makeConfig()).embed('hello'),
      ).rejects.toThrow('returned 2560 dimensions, expected 1024');
    });

    it('throws when the response contains no embedding data', async () => {
      mockFetch({ data: [{ index: 0, embedding: [] }] });

      await expect(
        new QwenEmbedder(makeConfig()).embed('hello'),
      ).rejects.toThrow('no embedding data');
    });

    // D9: a 401/403 here is the Cloudflare Access edge rejecting the
    // service token, not the vLLM box rejecting the request — named
    // explicitly so it doesn't read as an undifferentiated vLLM error in
    // ingest logs/alerts.
    it.each([401, 403])(
      'names Cloudflare Access on a %i response, not a generic vLLM error',
      async (status) => {
        mockFetch({ error: { message: 'boom' } }, false, status);

        await expect(
          new QwenEmbedder(makeConfig()).embed('hello'),
        ).rejects.toThrow(
          /rejected the request as unauthenticated.*CF_ACCESS_CLIENT_ID\/CF_ACCESS_CLIENT_SECRET/,
        );
      },
    );
  });

  describe('Cloudflare Access headers (D9)', () => {
    it('sends no CF-Access headers when the service token is unset (dev/CI open-LAN box)', async () => {
      const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

      await new QwenEmbedder(makeConfig()).embed('hello');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      expect(headers['CF-Access-Client-Secret']).toBeUndefined();
    });

    it('sends both CF-Access headers when the service token is configured', async () => {
      const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

      await new QwenEmbedder(
        makeConfig({
          cfAccessClientId: 'client-id-123',
          cfAccessClientSecret: 'client-secret-456',
        }),
      ).embed('hello');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBe('client-id-123');
      expect(headers['CF-Access-Client-Secret']).toBe('client-secret-456');
    });

    it('sends neither header when only one of the pair is set (both-or-neither)', async () => {
      const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

      await new QwenEmbedder(
        makeConfig({ cfAccessClientId: 'client-id-123' }),
      ).embed('hello');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
    });
  });
  // P0.3: this remote call is the retrieval path's dominant cost, and
  // "embedding took 300ms" is only actionable once the host's own compute is
  // separable from the transport around it.
  describe('call timings', () => {
    it('reports the header/body split and a total for the call', async () => {
      // Real timers with a controlled fetch: headers resolve after ~20ms and
      // the body ~20ms later, so ttfb/body/total must come out ordered rather
      // than all equal.
      const delayed = (ms: number, value: unknown) =>
        new Promise((resolve) => setTimeout(() => resolve(value), ms));
      global.fetch = jest.fn().mockImplementation(async () => {
        await delayed(20, null);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => delayed(20, { data: [{ index: 0, embedding: vec() }] }),
        };
      });

      const result = await new QwenEmbedder(makeConfig()).embed('hello');

      expect(result.timings).toBeDefined();
      expect(result.timings!.httpTtfbMs).toBeGreaterThanOrEqual(15);
      expect(result.timings!.httpBodyMs).toBeGreaterThanOrEqual(15);
      expect(result.timings!.totalMs).toBeGreaterThanOrEqual(
        result.timings!.httpTtfbMs + result.timings!.httpBodyMs,
      );
    });

    it("gives every vector in a batch the one call's timings", async () => {
      mockFetch({
        data: [
          { index: 0, embedding: vec() },
          { index: 1, embedding: vec(0.2) },
        ],
      });

      const [first, second] = await new QwenEmbedder(makeConfig()).embedBatch([
        'a',
        'b',
      ]);

      // They describe the HTTP call, not the individual embedding, so they
      // are identical by construction — asserted so a future per-vector
      // reading has to be a deliberate change.
      expect(first.timings).toEqual(second.timings);
    });
  });
  describe('warmUp()', () => {
    it('primes the pool with one real embedding call', async () => {
      const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });

      await new QwenEmbedder(makeConfig()).warmUp();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does the work once, however often it is called', async () => {
      const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });
      const embedder = new QwenEmbedder(makeConfig());

      await embedder.warmUp();
      await embedder.warmUp();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never throws when the host is unreachable — the pool just warms on first real use', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        new QwenEmbedder(makeConfig()).warmUp(),
      ).resolves.toBeUndefined();
    });

    it('stays unwarmed after a failure, so the next call retries', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const embedder = new QwenEmbedder(makeConfig());
      await embedder.warmUp();

      const fetchMock = mockFetch({ data: [{ index: 0, embedding: vec() }] });
      await embedder.warmUp();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
