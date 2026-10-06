// `GET /onboarding/tenant` over real HTTP, against a real Postgres and a
// real signed Supabase-shaped JWT. This endpoint gets integration coverage
// rather than unit coverage alone for one specific reason: the `tenants`
// table has NO row-level security policy, deliberately (a table defining
// what a tenant is cannot be scoped against itself — see tenants.table.ts).
// Every other tenant read in this codebase is caught by RLS if its predicate
// is ever dropped. This one is not. So the isolation claim has to be proven
// end to end against a database holding more than one tenant, not asserted
// against a mock that can only return what it was told to.
//
// Proves:
//   - unauthenticated requests are rejected (401)
//   - a caller receives their OWN tenant and never another one, with two
//     real tenant rows present to make a leak observable
//   - the `agent` role is served, not just `admin` — the sidebar renders for
//     both, and the rest of /onboarding/* is admin-gated
//   - a token whose tenant row is gone yields 404, not 500
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AgentConfigModule } from '../../src/modules/agent-config/agent-config.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';

type AppRole = 'admin' | 'agent';

function signToken(
  secret: string,
  overrides: { sub: string; tenantId: string; appRole: AppRole },
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: overrides.sub,
      role: 'authenticated',
      app_metadata: {
        tenant_id: overrides.tenantId,
        app_role: overrides.appRole,
      },
      exp: now + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

describe('GET /onboarding/tenant (tenant directory)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let httpServer: INestApplication;
  let jwtSecret: string;

  /** Typed accessor for the underlying node:http server — INestApplication.getHttpServer() is typed `any` upstream. */
  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userASub = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        AuthModule,
        AgentConfigModule,
        OnboardingModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;

    await persistence.runMigrations();

    // Two tenants, deliberately. With only one row present a broken
    // predicate would still return the "right" answer by accident.
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Acme Support' },
        { id: tenantB, name: 'Globex Support' },
      ]),
    );

    httpServer = moduleRef.createNestApplication();
    await httpServer.init();
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    // Same DI container as moduleRef, so closing both would run
    // PersistenceService.onModuleDestroy() (and pool.end()) twice.
    await httpServer.close();
  });

  it('rejects a request with no bearer token (401)', async () => {
    await request(server()).get('/onboarding/tenant').expect(401);
  });

  it("returns the caller's own tenant and never another one", async () => {
    const token = signToken(jwtSecret, {
      sub: userASub,
      tenantId: tenantA,
      appRole: 'admin',
    });

    const response = await request(server())
      .get('/onboarding/tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      id: tenantA,
      name: 'Acme Support',
      // v2 S1 profile fields, at their migration-0070 defaults.
      vertical: 'commerce',
      country: null,
      currency: null,
      defaultLocale: 'ar',
    });
    // The other tenant exists in the same table and must not appear.
    expect(JSON.stringify(response.body)).not.toContain(tenantB);
    expect(JSON.stringify(response.body)).not.toContain('Globex');
  });

  // The rest of /onboarding/* is @Roles('admin'). This route deliberately is
  // not, because the console sidebar renders for both roles.
  it('serves the agent role, not just admin', async () => {
    const token = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId: tenantB,
      appRole: 'agent',
    });

    const response = await request(server())
      .get('/onboarding/tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: tenantB,
      name: 'Globex Support',
    });
  });

  // A signed token whose tenant row is gone is a stale session. Since the
  // offboarding work, TenantAuthMiddleware's TenantStatusService reports a
  // missing tenant as CLOSED (fail closed: the purge already ran), so the
  // request stops at the middleware with 403 before the controller's 404 can
  // run. v2 aligned this test with that deliberate behaviour; it had been
  // failing on v1 since TenantStatusService landed.
  it('refuses (403) a token whose tenant no longer exists', async () => {
    const token = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId: randomUUID(),
      appRole: 'admin',
    });

    await request(server())
      .get('/onboarding/tenant')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('lets an admin update the workspace profile and nobody else’s', async () => {
    const token = signToken(jwtSecret, {
      sub: userASub,
      tenantId: tenantA,
      appRole: 'admin',
    });

    const response = await request(server())
      .patch('/onboarding/tenant/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ vertical: 'services', country: 'sa', currency: 'sar' })
      .expect(200);

    expect(response.body).toMatchObject({
      id: tenantA,
      vertical: 'services',
      country: 'SA',
      currency: 'SAR',
    });

    const [other] = await persistence.runAdminQuery((db) =>
      db
        .select({ vertical: tenants.vertical, currency: tenants.currency })
        .from(tenants)
        .where(inArray(tenants.id, [tenantB])),
    );
    expect(other).toEqual({ vertical: 'commerce', currency: null });
  });

  it('refuses the profile update for the agent role', async () => {
    const token = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId: tenantB,
      appRole: 'agent',
    });

    await request(server())
      .patch('/onboarding/tenant/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ vertical: 'services' })
      .expect(403);
  });
});
