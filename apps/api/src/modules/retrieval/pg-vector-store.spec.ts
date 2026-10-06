import type { Clock } from '../core/clock/clock';
import type { PartitionLifecycleService } from './partition-lifecycle.service';
import { PgVectorStore } from './pg-vector-store';
import type { VectorStoreChunk } from './ports/vector-store.port';
import type { TenantContextService } from '../tenant-context/tenant-context.service';

const TENANT_A = 'tenant-a';

// P0.3: search() now reports per-phase timings, so it needs a Clock. A
// monotonically advancing fake (10ms per call) is what lets the timing
// assertions below distinguish "this phase was measured" from "this phase was
// never reached" — a constant clock would make every phase read 0ms.
function makeClock(stepMs = 10): Clock {
  let calls = 0;
  return {
    now: () => new Date(calls * stepMs),
    nowMs: () => calls++ * stepMs,
  };
}

function makeTenantContext(
  executeResults: Array<{ rows?: unknown[]; rowCount?: number }>,
): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
  execute: jest.Mock;
} {
  let call = 0;
  const execute = jest.fn(() =>
    Promise.resolve(executeResults[call++] ?? { rows: [] }),
  );
  const withTenantTx = jest.fn((fn: (tx: { execute: jest.Mock }) => unknown) =>
    fn({ execute }),
  );
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
    execute,
  };
}

function makePartitionLifecycle(): {
  partitionLifecycle: PartitionLifecycleService;
  ensure: jest.Mock;
} {
  const ensure = jest.fn().mockResolvedValue(undefined);
  return {
    partitionLifecycle: {
      ensurePartitionForTenant: ensure,
    } as unknown as PartitionLifecycleService,
    ensure,
  };
}

function makeChunk(
  overrides: Partial<VectorStoreChunk> = {},
): VectorStoreChunk {
  return {
    id: 'chunk-1',
    tenantId: TENANT_A,
    content: 'Refunds take 5 days.',
    embedding: [0.1, 0.2],
    embeddingModel: 'test',
    embeddingVersion: 'v1',
    metadata: { kbDocumentId: 'doc-1', chunkIndex: 0 },
    ...overrides,
  };
}

describe('PgVectorStore.upsertChunks()', () => {
  it('ensures the tenant partition exists before inserting', async () => {
    const { tenantContext } = makeTenantContext([{ rows: [] }]);
    const { partitionLifecycle, ensure } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    await store.upsertChunks([makeChunk()]);

    expect(ensure).toHaveBeenCalledWith(TENANT_A);
  });

  it('is a no-op for an empty chunk list', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([]);
    const { partitionLifecycle, ensure } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    await store.upsertChunks([]);

    expect(ensure).not.toHaveBeenCalled();
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('rejects a batch mixing chunks from different tenants', async () => {
    const { tenantContext } = makeTenantContext([{ rows: [] }]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    await expect(
      store.upsertChunks([
        makeChunk({ tenantId: 'tenant-a' }),
        makeChunk({ tenantId: 'tenant-b' }),
      ]),
    ).rejects.toThrow(/same tenant/);
  });

  it('rejects a chunk missing kbDocumentId/chunkIndex metadata', async () => {
    const { tenantContext } = makeTenantContext([{ rows: [] }]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    await expect(
      store.upsertChunks([makeChunk({ metadata: {} })]),
    ).rejects.toThrow(/kbDocumentId/);
  });

  it('issues one INSERT per chunk', async () => {
    const { tenantContext, execute } = makeTenantContext([
      { rows: [] },
      { rows: [] },
    ]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    await store.upsertChunks([
      makeChunk({ id: 'chunk-1' }),
      makeChunk({ id: 'chunk-2' }),
    ]);

    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('PgVectorStore.search()', () => {
  it('fuses vector and lexical results via RRF and maps them back to content', async () => {
    const vectorRows = {
      rows: [{ id: 'chunk-1', content: 'Refunds take 5 days.' }],
    };
    const lexicalRows = {
      rows: [{ id: 'chunk-2', content: 'Shipping takes 3-5 days.' }],
    };
    const { tenantContext } = makeTenantContext([vectorRows, lexicalRows]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    const { results } = await store.search({
      tenantId: TENANT_A,
      queryEmbedding: [0.1, 0.2],
      queryText: 'refund shipping',
      topK: 5,
    });

    expect(results.map((r) => r.chunkId).sort()).toEqual([
      'chunk-1',
      'chunk-2',
    ]);
    expect(results.find((r) => r.chunkId === 'chunk-1')?.content).toBe(
      'Refunds take 5 days.',
    );
  });

  it('returns an empty array when both vector and lexical searches find nothing', async () => {
    const { tenantContext } = makeTenantContext([{ rows: [] }, { rows: [] }]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    const { results } = await store.search({
      tenantId: TENANT_A,
      queryEmbedding: [0.1, 0.2],
      queryText: 'nothing matches',
      topK: 5,
    });

    expect(results).toEqual([]);
  });

  it('truncates the fused result to topK', async () => {
    const vectorRows = {
      rows: [
        { id: 'chunk-1', content: 'a' },
        { id: 'chunk-2', content: 'b' },
        { id: 'chunk-3', content: 'c' },
      ],
    };
    const { tenantContext } = makeTenantContext([vectorRows, { rows: [] }]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(),
    );

    const { results } = await store.search({
      tenantId: TENANT_A,
      queryEmbedding: [0.1],
      queryText: 'x',
      topK: 2,
    });

    expect(results).toHaveLength(2);
  });

  // P0.3: the retrieval p95 bar cannot be diagnosed from one aggregate number.
  it('reports a per-phase timing breakdown covering both passes and fusion', async () => {
    const { tenantContext } = makeTenantContext([
      { rows: [{ id: 'chunk-1', content: 'a' }] },
      { rows: [] },
    ]);
    const { partitionLifecycle } = makePartitionLifecycle();
    const store = new PgVectorStore(
      tenantContext,
      partitionLifecycle,
      makeClock(10),
    );

    const { timings } = await store.search({
      tenantId: TENANT_A,
      queryEmbedding: [0.1],
      queryText: 'x',
      topK: 5,
    });

    // Clock ticks: searchStart(0) vectorStart(10) lexicalStart(20)
    // fusionStart(30) end(40) — each phase is one 10ms tick, and totalMs
    // spans the whole call INCLUDING the transaction/GUC setup before the
    // first query, which is why it is 40 and not the 30ms the phases sum to.
    expect(timings).toEqual({
      vectorQueryMs: 10,
      lexicalQueryMs: 10,
      fusionMs: 10,
      totalMs: 40,
    });
  });

  // D5: a re-embed migration leaves old-version chunks in the index. Without
  // this filter, search mixes two vector spaces and quality silently degrades.
  it('filters both the vector and the lexical pass by embedding_version when one is supplied', async () => {
    const { tenantContext, execute } = makeTenantContext([
      { rows: [] },
      { rows: [] },
    ]);
    const store = new PgVectorStore(
      tenantContext,
      makePartitionLifecycle().partitionLifecycle,
      makeClock(),
    );

    await store.search({
      tenantId: TENANT_A,
      queryEmbedding: [0.1, 0.2],
      queryText: 'refunds',
      topK: 5,
      embeddingVersion: 'q1',
    });

    expect(execute).toHaveBeenCalledTimes(2);
    for (const [query] of execute.mock.calls as Array<[unknown]>) {
      const rendered = JSON.stringify(query);
      expect(rendered).toContain('embedding_version');
      expect(rendered).toContain('q1');
    }
  });

  it('omits the embedding_version predicate entirely when no version is supplied', async () => {
    const { tenantContext, execute } = makeTenantContext([
      { rows: [] },
      { rows: [] },
    ]);
    const store = new PgVectorStore(
      tenantContext,
      makePartitionLifecycle().partitionLifecycle,
      makeClock(),
    );

    await store.search({
      tenantId: TENANT_A,
      queryEmbedding: [0.1, 0.2],
      queryText: 'refunds',
      topK: 5,
    });

    for (const [query] of execute.mock.calls as Array<[unknown]>) {
      expect(JSON.stringify(query)).not.toContain('embedding_version');
    }
  });
});

describe('PgVectorStore.deleteByDocument()', () => {
  it("removes the document's chunks so a deleted document stops being retrievable", async () => {
    const { tenantContext, execute, withTenantTx } = makeTenantContext([
      { rows: [], rowCount: 3 },
    ]);
    const store = new PgVectorStore(
      tenantContext,
      makePartitionLifecycle().partitionLifecycle,
      makeClock(),
    );

    await expect(store.deleteByDocument('tenant-a', 'doc-1')).resolves.toBe(3);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-a');
    expect(execute).toHaveBeenCalledTimes(1);
    const [query] = execute.mock.calls[0] as [unknown];
    const rendered = JSON.stringify(query);
    expect(rendered).toContain('DELETE FROM kb_chunks');
  });

  it('names tenant_id in the predicate so Postgres prunes to one partition instead of scanning every tenant', async () => {
    const { tenantContext, execute } = makeTenantContext([
      { rows: [], rowCount: 0 },
    ]);
    const store = new PgVectorStore(
      tenantContext,
      makePartitionLifecycle().partitionLifecycle,
      makeClock(),
    );

    await store.deleteByDocument('tenant-a', 'doc-1');

    const [query] = execute.mock.calls[0] as [unknown];
    const rendered = JSON.stringify(query);
    expect(rendered).toContain('tenant_id');
    expect(rendered).toContain('kb_document_id');
  });

  it('reports zero when the document had no chunks, rather than pretending it removed something', async () => {
    const { tenantContext } = makeTenantContext([{ rows: [] }]);
    const store = new PgVectorStore(
      tenantContext,
      makePartitionLifecycle().partitionLifecycle,
      makeClock(),
    );

    await expect(store.deleteByDocument('tenant-a', 'doc-1')).resolves.toBe(0);
  });
});
