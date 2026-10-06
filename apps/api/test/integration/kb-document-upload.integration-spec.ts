// Feature 6 exit criteria (former FEATURE_PLAN.md): "a new tenant can...
// upload a KB document through the UI, and have it indexed and
// retrievable." This proves the full path — HTTP upload -> `kb_documents`
// row -> real `kb-ingest` BullMQ worker -> `ingested` — against real
// Postgres + Redis + BullMQ. `Embedder` is overridden with the same
// deterministic FakeEmbedder `retrieval-pipeline.integration-spec.ts`
// uses (no OpenAI account provisioned in this environment); everything
// else, including the worker actually running, is real.
//
// The first test explicitly waits for the terminal `ingested` status
// (not just `ingest_queued`) before returning — `httpServer.init()`
// starts KbIngestProcessor's real BullMQ worker in the background, and if
// a test finished while that job was still in flight, `afterAll`'s tenant
// cleanup would race it (observed once during development: a Postgres
// deadlock between the in-flight ingest transaction and the cleanup
// DELETE, since both touch the same tenant-scoped rows under RLS).
// Waiting for a terminal status inside the test itself, not the DB-delete
// step, is what keeps `afterAll` safe to run in any order.
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { KnowledgeBaseModule } from '../../src/modules/knowledge-base/knowledge-base.module';
import { Embedder } from '../../src/modules/llm/ports/embedder.port';
import {
  kbDocuments,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
// Shared fixture: this suite doesn't test embedding quality, but the
// `kb-ingest` worker still picks up the enqueued job in the background, and
// letting it hit the real embedding provider with this environment's
// placeholder key would mean slow, noisy, guaranteed-failing retries during
// the run. The width is pinned in one place (see the fixture) so a column
// retype like migration 0023 can't leave stale literals behind here.
import { FakeEmbedder } from './fixtures/deterministic-embedding';

function signToken(
  secret: string,
  overrides: { sub: string; tenantId: string; appRole?: 'admin' | 'agent' },
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: overrides.sub,
      role: 'authenticated',
      app_metadata: {
        tenant_id: overrides.tenantId,
        ...(overrides.appRole && { app_role: overrides.appRole }),
      },
      exp: now + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

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

describe('KB document upload (Feature 6 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let httpServer: INestApplication;
  let jwtSecret: string;

  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  const tenantId = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        KnowledgeBaseModule,
      ],
    })
      .overrideProvider(Embedder)
      .useClass(FakeEmbedder)
      .compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'KB Upload Tenant' }),
    );

    httpServer = moduleRef.createNestApplication();
    await httpServer.init();
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await httpServer.close();
  });

  it('admin can upload a text KB document, which is indexed end to end by the real worker', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const uploadResponse = await request(server())
      .post('/knowledge-base/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('# Refund policy\nRefunds within 30 days.'), {
        filename: 'refund-policy.md',
        contentType: 'text/markdown',
      })
      .expect(201);

    const uploaded = uploadResponse.body as { id: string };
    expect(uploadResponse.body).toMatchObject({
      tenantId,
      filename: 'refund-policy.md',
      mimeType: 'text/markdown',
    });
    const documentId = uploaded.id;

    // Waits for the real worker to finish (success or terminal failure),
    // not just the synchronous "job enqueued" status — see the header
    // comment on why this matters for safe teardown.
    let finalStatus: string | undefined;
    await waitUntil(async () => {
      const [row] = await tenantContext.withTenantTx(
        (tx) =>
          tx
            .select()
            .from(kbDocuments)
            .where(eq(kbDocuments.id, documentId))
            .limit(1),
        tenantId,
      );
      finalStatus = row?.status;
      return row?.status === 'ingested' || row?.status === 'failed';
    });

    expect(finalStatus).toBe('ingested');

    const listResponse = await request(server())
      .get('/knowledge-base/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listed = (listResponse.body as Array<{ id: string }>).find(
      (doc) => doc.id === documentId,
    );
    expect(listed).toBeDefined();
  });

  it('rejects a non-text upload with 400', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    await request(server())
      .post('/knowledge-base/documents')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('%PDF-1.4 fake'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('agent role is forbidden from uploading or listing KB documents', async () => {
    const agentToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'agent',
    });

    await request(server())
      .get('/knowledge-base/documents')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);

    await request(server())
      .post('/knowledge-base/documents')
      .set('Authorization', `Bearer ${agentToken}`)
      .attach('file', Buffer.from('hello'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(403);
  });
});
