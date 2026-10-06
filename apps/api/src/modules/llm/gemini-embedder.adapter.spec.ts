import type { AppConfigService } from '../core';
import { GeminiEmbedder } from './gemini-embedder.adapter';

const DIMENSIONS = 1024;

function makeConfig(): AppConfigService {
  return {
    geminiApiKey: 'test-key',
    embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: DIMENSIONS,
  } as unknown as AppConfigService;
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

describe('GeminiEmbedder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the embedding vector, model and version', async () => {
    const values = Array.from({ length: DIMENSIONS }, () => 0.1);
    mockFetch({ embedding: { values } });

    const result = await new GeminiEmbedder(makeConfig()).embed('hello');

    expect(result.values).toHaveLength(DIMENSIONS);
    expect(result.embeddingModel).toBe('gemini-embedding-001');
    // 'g1', not 'v1' — Gemini vectors are not comparable with the OpenAI
    // adapter's, so the version tag must distinguish them.
    expect(result.embeddingVersion).toBe('g1');
  });

  // kb_chunks.embedding is vector(1024) while Gemini natively returns 3072 —
  // omitting outputDimensionality would produce vectors Postgres rejects.
  it('pins outputDimensionality and the retrieval task type on the request', async () => {
    const values = Array.from({ length: DIMENSIONS }, () => 0.1);
    const fetchMock = mockFetch({ embedding: { values } });

    await new GeminiEmbedder(makeConfig()).embed('hello');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('gemini-embedding-001:embedContent');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.outputDimensionality).toBe(DIMENSIONS);
    expect(body.taskType).toBe('RETRIEVAL_DOCUMENT');
  });

  it('throws on a non-OK response without echoing the body back', async () => {
    mockFetch({ error: { message: 'key=SECRET leaked here' } }, false, 400);

    await expect(
      new GeminiEmbedder(makeConfig()).embed('hello'),
    ).rejects.toThrow(/HTTP 400/);
    await expect(
      new GeminiEmbedder(makeConfig()).embed('hello'),
    ).rejects.not.toThrow(/SECRET/);
  });

  it('throws when the response carries no embedding data', async () => {
    mockFetch({});

    await expect(
      new GeminiEmbedder(makeConfig()).embed('hello'),
    ).rejects.toThrow(/no embedding data/);
  });

  // A wrong-length vector would otherwise surface as an opaque Postgres
  // dimension error inside the ingest worker, far from the cause.
  it('throws when the returned vector has the wrong dimension count', async () => {
    mockFetch({ embedding: { values: [0.1, 0.2, 0.3] } });

    await expect(
      new GeminiEmbedder(makeConfig()).embed('hello'),
    ).rejects.toThrow(/returned 3 dimensions, expected 1024/);
  });
});
