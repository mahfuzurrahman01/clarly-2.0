// Feature 6 exit criteria (former FEATURE_PLAN.md): "an admin can invite an
// agent who receives Agent-scoped (not Admin-scoped) access." Proves the
// team-invite endpoint against real Postgres + a real signed JWT for the
// inviting admin. `TENANT_PROVISIONING_PROVIDER` is unset in this
// environment (defaults to 'none'), so `NoopProvisioningAdapter` is what's
// actually exercised — no real email is sent, but the response still
// reports the invited role, which is the thing this exit criterion is
// actually about (the invited user gets Agent claims, not Admin ones).
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

describe('Team invite (Feature 6 exit criteria)', () => {
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
      db.insert(tenants).values({ id: tenantId, name: 'Invite Tenant' }),
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

  it('an admin can invite a new user as agent-scoped (not admin-scoped) access', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const response = await request(server())
      .post('/onboarding/team/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'agent@example.com', appRole: 'agent' })
      .expect(201);

    expect(response.body).toMatchObject({
      email: 'agent@example.com',
      appRole: 'agent',
      invited: false,
    });
  });

  it('an admin can also invite a new user as admin-scoped access', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const response = await request(server())
      .post('/onboarding/team/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'coadmin@example.com', appRole: 'admin' })
      .expect(201);

    expect(response.body).toMatchObject({ appRole: 'admin' });
  });

  it('agent role is forbidden from inviting anyone', async () => {
    const agentToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'agent',
    });

    await request(server())
      .post('/onboarding/team/invite')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ email: 'someone@example.com', appRole: 'agent' })
      .expect(403);
  });

  it('rejects an invalid email with 400', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    await request(server())
      .post('/onboarding/team/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'not-an-email', appRole: 'agent' })
      .expect(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(server())
      .post('/onboarding/team/invite')
      .send({ email: 'agent@example.com', appRole: 'agent' })
      .expect(401);
  });
});
