// Feature 2.5 exit criteria (former FEATURE_PLAN.md): "a tenant can be seeded
// (SQL/script, no UI) with a policy row and one indexed KB document, ready
// for Feature 3 to build and verify A1/A5/A6 against." "Indexed" here means
// "handed to the ingest pipeline" (kb_documents.status reaches
// ingest_queued and a kb-ingest job exists) — actual chunking/embedding is
// Feature 3's A1 work, which doesn't exist yet; see
// docs/decisions/F2.5-kb-foundation.md for why this isn't a contradiction.
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { AppConfigService } from '../../src/modules/core';
import { KnowledgeBaseModule } from '../../src/modules/knowledge-base/knowledge-base.module';
import { KbDocumentService } from '../../src/modules/knowledge-base/kb-document.service';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { TenantPolicyService } from '../../src/modules/onboarding/tenant-policy.service';
import {
  kbDocuments,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

describe('Tenant policy & KB foundation (Feature 2.5 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let tenantPolicy: TenantPolicyService;
  let kbDocumentService: KbDocumentService;
  let storageDir: string;

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    storageDir = join(tmpdir(), `kb-foundation-test-${randomUUID()}`);
    process.env.KB_LOCAL_STORAGE_DIR = storageDir;

    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        KnowledgeBaseModule,
        OnboardingModule,
      ],
    }).compile();

    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    tenantPolicy = moduleRef.get(TenantPolicyService);
    kbDocumentService = moduleRef.get(KbDocumentService);

    await persistence.runMigrations();

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Policy/KB Test Tenant A' },
        { id: tenantB, name: 'Policy/KB Test Tenant B' },
      ]),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db
        .delete(kbDocuments)
        .where(inArray(kbDocuments.tenantId, [tenantA, tenantB])),
    );
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

  describe('T15: tenant policy schema', () => {
    it('a tenant can be seeded with a policy row via script (no UI)', async () => {
      const record = await tenantPolicy.upsert(tenantA, {
        confidenceThreshold: 0.8,
        forbiddenTopics: ['refunds', 'competitor-pricing'],
        tonePersonaOverride: 'Friendly and concise.',
      });

      expect(record).toEqual({
        tenantId: tenantA,
        confidenceThreshold: 0.8,
        forbiddenTopics: ['refunds', 'competitor-pricing'],
        tonePersonaOverride: 'Friendly and concise.',
        // rerankEnabled defaults true (D4) — not set explicitly by this
        // seed call, added to TenantPolicyRecord in Feature 4 once
        // AgentRuntime actually needed to read it (Feature 3/A1's
        // migration added the column; this is when it got exposed).
        rerankEnabled: true,
        // stuckTicketThresholdMinutes defaults 15 (T4) — column/field added
        // in Feature 5 once AlertingModule needed to read it.
        stuckTicketThresholdMinutes: 15,
      });
    });

    it('an un-seeded tenant has no policy row (no default row auto-created)', async () => {
      await expect(tenantPolicy.getForTenant(tenantB)).resolves.toBeNull();
    });

    it('RLS: tenant A cannot read tenant B policy data, even with a hand-crafted query', async () => {
      await tenantPolicy.upsert(tenantB, { confidenceThreshold: 0.65 });

      const rows = await tenantContext.withTenantTx(async (tx) => {
        const result = await tx.execute(
          sql`select tenant_id from tenant_policy where tenant_id = ${tenantB}`,
        );
        return result.rows;
      }, tenantA);

      expect(rows).toHaveLength(0);
    });
  });

  describe('T15/T6: KB upload mechanism feeding A1 ingest', () => {
    it('a tenant can be seeded with one KB document via script (no UI)', async () => {
      const content = Buffer.from(
        'Refunds are processed within 5 business days.',
      );

      const record = await kbDocumentService.upload(
        tenantA,
        'refund-policy.txt',
        'text/plain',
        content,
      );

      expect(record.status).toBe('ingest_queued');
      expect(record.filename).toBe('refund-policy.txt');
      expect(record.tenantId).toBe(tenantA);
    });

    // Was written against the pre-Feature-3 PLACEHOLDER ingest processor,
    // which could only ever reach 'failed', and asserted exactly that. A1's
    // real pipeline has since landed, so a successful ingest now reaches
    // 'ingested' and the assertion started timing out on a working system.
    // The property this test is actually named for survives the rewrite:
    // an uploaded document always reaches a TERMINAL status and is never
    // left silently parked in 'uploaded'/'ingest_queued'. Which terminal
    // status it reaches depends on whether this environment has a live
    // embedder, which is not what this Feature 2.5 suite is about.
    it('an uploaded document always reaches a terminal ingest status, never silently stuck', async () => {
      const content = Buffer.from('Shipping takes 3-5 days.');
      const record = await kbDocumentService.upload(
        tenantA,
        'shipping.txt',
        'text/plain',
        content,
      );

      await waitUntil(async () => {
        const docs = await kbDocumentService.listForTenant(tenantA);
        const doc = docs.find((d) => d.id === record.id);
        return doc?.status === 'ingested' || doc?.status === 'failed';
      }, 15000);
    });

    it('RLS: tenant A cannot see tenant B KB documents', async () => {
      await kbDocumentService.upload(
        tenantB,
        'tenant-b-only.txt',
        'text/plain',
        Buffer.from('secret'),
      );

      const tenantADocs = await kbDocumentService.listForTenant(tenantA);
      expect(
        tenantADocs.every((doc) => doc.filename !== 'tenant-b-only.txt'),
      ).toBe(true);
    });
  });

  it('sanity: AppConfigService resolves the local KB storage dir used by this suite', () => {
    const config = moduleRef.get(AppConfigService);
    expect(config.kbLocalStorageDir).toBe(storageDir);
  });
});
