import { KBNotIndexed } from '@repo/errors';
import type { AppLoggerService } from '../core';
import type { Clock } from '../core/clock/clock';
import type { Embedder } from '../llm/ports/embedder.port';
import type { Reranker } from './ports/reranker.port';
import type { VectorStore } from './ports/vector-store.port';
import { RetrievalSearchService } from './retrieval-search.service';

// P0.3: a fake Clock that advances a fixed step per reading, so every phase
// of search() gets a distinct, predictable duration. A constant clock would
// make all of them 0 and assert nothing.
function makeClock(stepMs = 10): Clock {
  let calls = 0;
  return {
    now: () => new Date(calls * stepMs),
    nowMs: () => calls++ * stepMs,
  };
}

/** Returns the mock fns alongside the logger — asserting on `logger.error` directly trips @typescript-eslint/unbound-method. */
function makeLogger(): { logger: AppLoggerService; error: jest.Mock } {
  const error = jest.fn();
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error,
  } as unknown as AppLoggerService;
  return { logger, error };
}

function makeEmbedder(timings?: {
  httpTtfbMs: number;
  httpBodyMs: number;
  totalMs: number;
}): { embedder: Embedder; embed: jest.Mock } {
  const embed = jest.fn().mockResolvedValue({
    values: [0.1, 0.2],
    embeddingModel: 'test',
    embeddingVersion: 'v1',
    timings,
  });
  return { embedder: { embed }, embed };
}

function makeVectorStore(
  results: Array<{ chunkId: string; content: string; score: number }>,
): { vectorStore: VectorStore; search: jest.Mock } {
  const search = jest.fn().mockResolvedValue({
    results,
    timings: {
      vectorQueryMs: 3,
      lexicalQueryMs: 2,
      fusionMs: 1,
      totalMs: 7,
    },
  });
  return { vectorStore: { search } as unknown as VectorStore, search };
}

function makeReranker(): { reranker: Reranker; rerank: jest.Mock } {
  const rerank = jest
    .fn()
    .mockImplementation(
      (_q: string, candidates: Array<{ id: string }>, topN: number) =>
        Promise.resolve(
          candidates
            .slice(0, topN)
            .map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })),
        ),
    );
  return { reranker: { rerank }, rerank };
}

const CANDIDATE_RESULTS = [
  { chunkId: 'chunk-1', content: 'Refunds take 5 days.', score: 0.9 },
  { chunkId: 'chunk-2', content: 'Shipping takes 3-5 days.', score: 0.8 },
];

describe('RetrievalSearchService.search()', () => {
  it('embeds the query once and returns it for reuse (D12)', async () => {
    const { embedder, embed } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search(
      'tenant-a',
      'when do refunds arrive',
      true,
    );

    expect(result.queryEmbedding).toEqual([0.1, 0.2]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('calls the reranker when rerankEnabled is true', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker, rerank } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    await service.search('tenant-a', 'query', true);

    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it('skips the reranker when rerankEnabled is false (D4 per-tenant flag)', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker, rerank } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', false);

    expect(rerank).not.toHaveBeenCalled();
    expect(result.chunks.map((c) => c.id)).toEqual(['chunk-1', 'chunk-2']);
  });

  it('throws KBNotIndexed when the vector store returns no candidates at all', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore([]);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    await expect(service.search('tenant-a', 'query', true)).rejects.toThrow(
      KBNotIndexed,
    );
  });

  it('returns zero chunks with the query embedding instead of throwing when allowEmpty is set', async () => {
    const { embedder, embed } = makeEmbedder();
    const { vectorStore } = makeVectorStore([]);
    const { reranker, rerank } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', true, undefined, {
      allowEmpty: true,
    });

    expect(result.chunks).toEqual([]);
    expect(result.queryEmbedding).toEqual([0.1, 0.2]);
    expect(embed).toHaveBeenCalledTimes(1);
    // Nothing to rank — the reranker round trip is skipped, not wasted.
    expect(rerank).not.toHaveBeenCalled();
    expect(result.timings.rerankMs).toBe(0);
  });

  it('maps reranked results back to their original content', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', true);

    expect(result.chunks[0]).toEqual({
      id: 'chunk-1',
      content: 'Refunds take 5 days.',
      score: 1,
    });
  });

  // Rerank is a quality refinement on an already-usable RRF-fused ranking.
  // Letting its failure propagate meant a Cohere 429 escaped search(),
  // escaped AgentRuntime.respond(), failed the BullMQ job, burned all three
  // respond-path retries (three more LLM calls) and ended as a TOOL_FAILURE
  // ticket — a human summoned because a ranking refinement was rate-limited.
  it('degrades to the RRF-fused order instead of failing the turn when the reranker throws', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker, rerank } = makeReranker();
    rerank.mockRejectedValue(new Error('Cohere rerank request failed: 429'));
    const { logger, error } = makeLogger();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      logger,
    );

    const result = await service.search('tenant-a', 'query', true);

    // Same ranking a rerank-disabled tenant is served — not an empty result,
    // not a throw.
    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      'chunk-1',
      'chunk-2',
    ]);
    expect(result.chunks[0].content).toBe('Refunds take 5 days.');
    // Degradation is never silent: a revoked key would otherwise look
    // exactly like a transient blip from inside any single turn.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('rerank failed'),
      undefined,
      'RetrievalSearchService',
    );
  });
});

// P0.3: retrieval p95 fails its <400ms bar on every eval run, and a single
// aggregate span cannot say whether the remote embedder, the database, or the
// reranker is responsible. These tests pin the attribution.
describe('RetrievalSearchService.search() — phase timings', () => {
  it('attributes wall clock to the embed call, the store call and rerank separately', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(10),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', true);

    // Clock ticks: start(0) embedDone(10) storeDone(20) end(30).
    expect(result.timings.embedMs).toBe(10);
    expect(result.timings.storeMs).toBe(10);
    expect(result.timings.rerankMs).toBe(10);
    expect(result.timings.totalMs).toBe(30);
  });

  it('passes the store’s own vector/lexical/fusion split straight through', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', false);

    expect(result.timings.vectorQueryMs).toBe(3);
    expect(result.timings.lexicalQueryMs).toBe(2);
    expect(result.timings.fusionMs).toBe(1);
  });

  it('records rerank as 0ms when the tenant has rerank disabled (D4 flag)', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(10),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', false);

    // Not merely "small" — the reranker was never called, and reporting the
    // trailing in-process mapping time as rerank cost would misattribute it.
    expect(result.timings.rerankMs).toBe(0);
  });

  it("surfaces the embedder's HTTP header/body split when the adapter reports it", async () => {
    const { embedder } = makeEmbedder({
      httpTtfbMs: 280,
      httpBodyMs: 15,
      totalMs: 295,
    });
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', false);

    expect(result.timings.embedHttpTtfbMs).toBe(280);
    expect(result.timings.embedHttpBodyMs).toBe(15);
  });

  it('leaves the HTTP split undefined for an embedder that cannot measure it', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore } = makeVectorStore(CANDIDATE_RESULTS);
    const { reranker } = makeReranker();
    const service = new RetrievalSearchService(
      embedder,
      vectorStore,
      reranker,
      makeClock(),
      makeLogger().logger,
    );

    const result = await service.search('tenant-a', 'query', false);

    // undefined, not 0 — "not measured" must never read as "instantaneous".
    expect(result.timings.embedHttpTtfbMs).toBeUndefined();
  });
});
