// Feature 5 exit criteria (former FEATURE_PLAN.md): "admin role can manage
// team/config, agent role cannot." This is the endpoint that proves it —
// KanbanModule's ticket endpoints (Slice 3) are deliberately ungated and
// don't exercise T14's admin/agent split at all; TenantPolicyController
// (pulled forward from its original Feature 6 slot, see its own header
// comment) is the first and only admin-gated HTTP surface in the app.
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';

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

describe('Tenant-policy admin RBAC (Feature 5 exit criteria, T14)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
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
        OnboardingModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'RBAC Tenant' }),
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

  it('admin role can read and update tenant policy', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    await request(server())
      .patch('/onboarding/tenant-policy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confidenceThreshold: 0.85 })
      .expect(200);

    const getResponse = await request(server())
      .get('/onboarding/tenant-policy')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(getResponse.body).toMatchObject({
      tenantId,
      confidenceThreshold: 0.85,
    });
  });

  it('agent role is forbidden from both reading and writing tenant policy', async () => {
    const agentToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'agent',
    });

    await request(server())
      .get('/onboarding/tenant-policy')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);

    await request(server())
      .patch('/onboarding/tenant-policy')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ confidenceThreshold: 0.1 })
      .expect(403);
  });

  it('a token with no app_role at all is forbidden (fails closed, not open)', async () => {
    const noRoleToken = signToken(jwtSecret, { sub: randomUUID(), tenantId });

    await request(server())
      .get('/onboarding/tenant-policy')
      .set('Authorization', `Bearer ${noRoleToken}`)
      .expect(403);
  });

  it('rejects an unauthenticated request with 401 before RolesGuard even runs', async () => {
    await request(server()).get('/onboarding/tenant-policy').expect(401);
  });
});
