// Feature 6 exit criteria (former FEATURE_PLAN.md): "a new tenant can sign
// up..." — this proves the signup endpoint against real Postgres: a
// freshly-signed Supabase-shaped JWT with NO app_metadata.tenant_id yet
// (the actual shape a brand-new Supabase Auth user's token has) can call
// `POST /onboarding/signup` and get a real `tenants` row back, without
// ever going through TenantAuthMiddleware (which would reject a
// tenant-less token outright). `TENANT_PROVISIONING_PROVIDER` is unset in
// this environment's `.env` (defaults to 'none' — no Supabase project
// provisioned), so `NoopProvisioningAdapter` is what's actually exercised
// here; the real `SupabaseAdminProvisioningAdapter` has its own unit
// tests with a mocked `@supabase/supabase-js` client (no real project to
// integration-test against).
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
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

function signFreshSignupToken(
  secret: string,
  overrides: { sub: string; tenantId?: string } = { sub: randomUUID() },
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: overrides.sub,
      exp: now + 3600,
      ...(overrides.tenantId && {
        app_metadata: { tenant_id: overrides.tenantId },
      }),
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

describe('Tenant signup (Feature 6 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let httpServer: INestApplication;
  let jwtSecret: string;
  const createdTenantIds: string[] = [];

  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

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

    httpServer = moduleRef.createNestApplication();
    await httpServer.init();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await persistence.runAdminQuery((db) =>
        db.delete(tenants).where(inArray(tenants.id, createdTenantIds)),
      );
    }
    await httpServer.close();
  });

  it('a freshly-signed-up user (no tenant_id in their token yet) can create a tenant', async () => {
    const token = signFreshSignupToken(jwtSecret);

    const response = await request(server())
      .post('/onboarding/signup')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantName: 'Acme Corp' })
      .expect(201);

    expect(response.body).toMatchObject({
      tenantName: 'Acme Corp',
      claimsAssigned: false,
    });
    const body = response.body as { tenantId: string };
    expect(body.tenantId).toEqual(expect.any(String));
    createdTenantIds.push(body.tenantId);
  });

  it('rejects signup for a token that already carries a tenant_id (409, no duplicate tenant)', async () => {
    const token = signFreshSignupToken(jwtSecret, {
      sub: randomUUID(),
      tenantId: randomUUID(),
    });

    await request(server())
      .post('/onboarding/signup')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantName: 'Should Not Be Created' })
      .expect(409);
  });

  it('rejects an unauthenticated signup request with 401', async () => {
    await request(server())
      .post('/onboarding/signup')
      .send({ tenantName: 'No Auth Co' })
      .expect(401);
  });

  it('rejects a signup body with no tenantName (400)', async () => {
    const token = signFreshSignupToken(jwtSecret);

    await request(server())
      .post('/onboarding/signup')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });
});
