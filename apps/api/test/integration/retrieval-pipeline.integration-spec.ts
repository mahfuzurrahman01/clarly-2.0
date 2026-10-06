// Feature 3/A1 exit criteria (docs/AI_PIPELINE_PLAN.md): "empty-KB tenant
// raises KBNotIndexed, not an empty answer" plus the underlying
// infrastructure claims (D3: per-tenant partition + HNSW lifecycle; D4:
// hybrid search) — this suite proves those against a real pgvector-enabled
// Postgres, not mocks. The one thing it does NOT prove against a real
// vendor is embedding quality: `Embedder` is overridden with a
// deterministic FakeEmbedder (see docs/decisions/F3-agent-core.md) since no
// OpenAI account is provisioned in this environment. That's a deliberate,
// narrow substitution — every other piece (partition DDL, HNSW/GIN index
// auto-propagation, RLS, hybrid search SQL, RRF fusion) runs for real.
//
// Requires real Postgres (pgvector extension enabled) + Redis. Run via
// `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { KBNotIndexed } from '@repo/errors';
import { CoreModule } from '../../src/modules/core/core.module';
import { Embedder } from '../../src/modules/llm/ports/embedder.port';
import { FakeEmbedder } from './fixtures/deterministic-embedding';
import { KbDocumentService } from '../../src/modules/knowledge-base/kb-document.service';
import { KnowledgeBaseModule } from '../../src/modules/knowledge-base/knowledge-base.module';
import {
  kbDocuments,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RetrievalIngestService } from '../../src/modules/retrieval/retrieval-ingest.service';
import { RetrievalModule } from '../../src/modules/retrieval/retrieval.module';
import { RetrievalSearchService } from '../../src/modules/retrieval/retrieval-search.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

/** Deterministic — same text always produces the same vector — so an exact-text query can be asserted to rank its own chunk first via the vector channel specifically, without needing a real embedding model. */
async function seedKbDocument(
  tenantContext: TenantContextService,
  tenantId: string,
): Promise<string> {
  const id = randomUUID();
  await tenantContext.withTenantTx(
    (tx) =>
      tx.insert(kbDocuments).values({
        id,
        tenantId,
        filename: 'seeded.txt',
        storageKey: `${tenantId}/${id}`,
        mimeType: 'text/plain',
        sizeBytes: 0,
        status: 'uploaded',
      }),
    tenantId,
  );
  return id;
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

describe('Retrieval pipeline (Feature 3/A1)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let retrievalIngest: RetrievalIngestService;
  let retrievalSearch: RetrievalSearchService;
  let kbDocumentService: KbDocumentService;
  let storageDir: string;

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    storageDir = join(tmpdir(), `retrieval-test-${randomUUID()}`);
    process.env.KB_LOCAL_STORAGE_DIR = storageDir;

    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        RetrievalModule,
        KnowledgeBaseModule,
      ],
    })
      .overrideProvider(Embedder)
      .useClass(FakeEmbedder)
      .compile();

    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    retrievalIngest = moduleRef.get(RetrievalIngestService);
    retrievalSearch = moduleRef.get(RetrievalSearchService);
    kbDocumentService = moduleRef.get(KbDocumentService);

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Retrieval Test Tenant A' },
        { id: tenantB, name: 'Retrieval Test Tenant B' },
      ]),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantA)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantB)),
    );
    await moduleRef.close();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.KB_LOCAL_STORAGE_DIR;
  });

  it('D3: an empty-KB tenant raises KBNotIndexed on search, not an empty answer', async () => {
    await expect(
      retrievalSearch.search(tenantB, 'anything', false),
    ).rejects.toThrow(KBNotIndexed);
  });

  it('D3/A1: ingesting creates the tenant partition (auto-inheriting the parent HNSW/GIN indexes) and the chunk becomes searchable', async () => {
    const kbDocumentId = await seedKbDocument(tenantContext, tenantA);
    const result = await retrievalIngest.ingestDocument({
      tenantId: tenantA,
      kbDocumentId,
      content: Buffer.from(
        'Refunds are processed within 5 business days of the return being received.',
      ),
      mimeType: 'text/plain',
    });

    expect(result.chunkCount).toBeGreaterThan(0);

    const found = await retrievalSearch.search(
      tenantA,
      'refund processing time',
      false,
    );
    expect(found.chunks.length).toBeGreaterThan(0);
    expect(
      found.chunks.some((chunk) =>
        chunk.content.includes('Refunds are processed'),
      ),
    ).toBe(true);
  });

  it('D4: hybrid search surfaces the lexically-relevant chunk over an unrelated one', async () => {
    const kbDocumentId = await seedKbDocument(tenantContext, tenantA);
    await retrievalIngest.ingestDocument({
      tenantId: tenantA,
      kbDocumentId,
      content: Buffer.from(
        'Our store hours are 9am to 6pm, Monday through Saturday.',
      ),
      mimeType: 'text/plain',
    });

    const result = await retrievalSearch.search(tenantA, 'store hours', false);

    expect(result.chunks[0]?.content).toContain('store hours are 9am to 6pm');
  });

  it('vector channel: a query embedded identically to a chunk ranks that chunk via cosine distance', async () => {
    const exactText =
      'A very specific unique sentence about warranty claims processing timelines.';
    const kbDocumentId = await seedKbDocument(tenantContext, tenantA);
    await retrievalIngest.ingestDocument({
      tenantId: tenantA,
      kbDocumentId,
      content: Buffer.from(exactText),
      mimeType: 'text/plain',
    });

    const result = await retrievalSearch.search(tenantA, exactText, false);

    expect(result.chunks.some((chunk) => chunk.content === exactText)).toBe(
      true,
    );
  });

  it('RLS: tenant A cannot see tenant B chunks even indirectly through search', async () => {
    const kbDocumentId = await seedKbDocument(tenantContext, tenantB);
    await retrievalIngest.ingestDocument({
      tenantId: tenantB,
      kbDocumentId,
      content: Buffer.from('Tenant B secret pricing sheet, internal use only.'),
      mimeType: 'text/plain',
    });

    const resultForA = await retrievalSearch.search(
      tenantA,
      'secret pricing sheet',
      false,
    );

    expect(
      resultForA.chunks.every(
        (chunk) => !chunk.content.includes('Tenant B secret'),
      ),
    ).toBe(true);
  });

  it('end-to-end via the real kb-ingest queue: KbDocumentService.upload() -> KbIngestProcessor -> kb_documents.status reaches "ingested"', async () => {
    const record = await kbDocumentService.upload(
      tenantA,
      'shipping-policy.txt',
      'text/plain',
      Buffer.from('International shipping takes 10-14 business days.'),
    );

    await waitUntil(async () => {
      const docs = await kbDocumentService.listForTenant(tenantA);
      return docs.find((doc) => doc.id === record.id)?.status === 'ingested';
    });

    const result = await retrievalSearch.search(
      tenantA,
      'international shipping duration',
      false,
    );
    expect(
      result.chunks.some((chunk) =>
        chunk.content.includes('International shipping'),
      ),
    ).toBe(true);
  });
});
