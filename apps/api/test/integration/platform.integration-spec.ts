// Clarly 2.0 S1: the operator console API over real HTTP, real Postgres and a
// real signed Supabase-shaped JWT.
//
// Proves:
//   - a valid tenant admin's token is NOT operator access (403) — operator
//     access exists only through `platform_admins`
//   - an operator token needs no tenant claim at all
//   - the tenant list reads every tenant's subscription through that
//     tenant's own RLS scope (a subscription row exists only under FORCE RLS,
//     so seeing it proves the per-tenant withTenantTx path works)
//   - search, keyset paging and the single-tenant read
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  plans,
  platformAdmins,
  tenants,
  tenantSubscriptions,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

interface TenantRow {
  id: string;
  name: string;
}
interface TenantPage {
  items: TenantRow[];
  nextCursor: string | null;
}

function sign(secret: string, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { role: 'authenticated', exp: now + 3600, ...claims },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

describe('/platform (operator console API)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let app: INestApplication;
  let secret: string;
  const server = (): Server => app.getHttpServer() as Server;

  const runTag = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const planId = randomUUID();
  const operator = randomUUID();
  const viewer = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        AuthModule,
        PlatformModule,
      ],
    }).compile();
    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    secret = moduleRef.get(AppConfigService).supabaseJwtSecret;
    await persistence.runMigrations();

    await persistence.runAdminQuery(async (db) => {
      await db.insert(tenants).values([
        { id: tenantA, name: `Lumen Clinic ${runTag}`, vertical: 'services' },
        { id: tenantB, name: `Noor Abayas ${runTag}` },
      ]);
      await db.insert(plans).values({
        id: planId,
        name: `Starter ${runTag}`,
        stripePriceId: `price_${runTag}`,
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
      });
      await db.insert(platformAdmins).values([
        {
          userId: operator,
          email: `owner-${runTag}@clarly.test`,
          role: 'owner',
        },
        {
          userId: viewer,
          email: `viewer-${runTag}@clarly.test`,
          role: 'viewer',
        },
      ]);
    });
    // FORCE RLS table: only writable inside the tenant's own scope.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantSubscriptions).values({
          tenantId: tenantA,
          planId,
          status: 'active',
        }),
      tenantA,
    );

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await persistence.runAdminQuery(async (db) => {
      await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
      await db.delete(plans).where(eq(plans.id, planId));
      await db
        .delete(platformAdmins)
        .where(inArray(platformAdmins.userId, [operator, viewer]));
    });
    await app.close();
  });

  it('401 without a token', async () => {
    await request(server()).get('/platform/me').expect(401);
  });

  it('403 for a tenant admin who is not an operator', async () => {
    const token = sign(secret, {
      sub: randomUUID(),
      app_metadata: { tenant_id: tenantA, app_role: 'admin' },
    });
    await request(server())
      .get('/platform/tenants')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('serves an operator whose token carries no tenant', async () => {
    const token = sign(secret, { sub: operator });
    const res = await request(server())
      .get('/platform/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      userId: operator,
      email: `owner-${runTag}@clarly.test`,
      role: 'owner',
    });
  });

  it('lists tenants with their subscription read through each tenant’s RLS scope', async () => {
    const token = sign(secret, { sub: viewer });
    const res = await request(server())
      .get('/platform/tenants')
      .query({ search: runTag })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = res.body as TenantPage;
    const byId = new Map(body.items.map((t) => [t.id, t]));
    expect(byId.size).toBe(2);
    expect(byId.get(tenantA)).toMatchObject({
      vertical: 'services',
      subscription: {
        status: 'active',
        planName: `Starter ${runTag}`,
        comped: false,
      },
      usage: { turns30d: 0, costUsd30d: 0 },
    });
    expect(byId.get(tenantB)).toMatchObject({
      vertical: 'commerce',
      subscription: null,
    });
  });

  it('pages with a keyset cursor without repeating rows', async () => {
    const token = sign(secret, { sub: viewer });
    const first = await request(server())
      .get('/platform/tenants')
      .query({ search: runTag, limit: 1 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const firstPage = first.body as TenantPage;
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await request(server())
      .get('/platform/tenants')
      .query({ search: runTag, limit: 1, cursor: firstPage.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const secondPage = second.body as TenantPage;
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('reads one tenant and 404s an unknown id', async () => {
    const token = sign(secret, { sub: operator });
    const res = await request(server())
      .get(`/platform/tenants/${tenantA}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as TenantRow).name).toBe(`Lumen Clinic ${runTag}`);

    await request(server())
      .get(`/platform/tenants/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
