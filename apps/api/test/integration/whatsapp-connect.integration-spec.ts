// WhatsApp connect surface after Gulf T3 (D3 Embedded Signup, D16 no card
// gate), against real Postgres:
//   - POST /whatsapp/connect/embedded-signup end to end (real guards,
//     validation, ConnectService, encrypted upsert, migration 0048's
//     connection_state), with Meta faked at EmbeddedSignupPort;
//   - a trialing tenant with no card connects (D16);
//   - a register failure after subscribe stores `reconnect_required`;
//   - a WABA the token was not granted on stores nothing (403);
//   - a number held by another tenant 409s before any Graph write, and
//     WhatsappConnectionService.connectNumber()'s ON CONFLICT guard holds;
//   - GET /whatsapp/connect/numbers (tenant-scoped, never credentials);
//   - the removed 360dialog routes are gone (404);
//   - ConnectStateService's signed, tenant-bound state.
//
// Requires real Postgres + Redis (same dependency chain as the other
// integration specs). Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { hashMetaUserId } from '../../src/modules/meta-graph/meta-user-id-hash';
import { BillingModule } from '../../src/modules/billing/billing.module';
import {
  ConnectModule,
  ConnectStateService,
  EmbeddedSignupError,
  EmbeddedSignupPort,
  WhatsappConnectionService,
} from '../../src/modules/whatsapp/connect/connect.module';
import { InvalidConnectStateError } from '../../src/modules/whatsapp/connect/connect-state.service';
import type {
  EmbeddedSignupGrant,
  EmbeddedSignupPhoneNumber,
} from '../../src/modules/whatsapp/connect/ports/embedded-signup.port';
import { ChannelOwnedByAnotherTenantError } from '../../src/modules/whatsapp/connect/whatsapp-connection.service';
import { BspCredentialsEncryptionService } from '../../src/modules/whatsapp/bsp-credentials-encryption.service';
import {
  plans,
  tenants,
  tenantSubscriptions,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

process.env.WHATSAPP_CONNECT_STATE_SECRET ??= 'integration-test-state-secret';

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

/** Meta, faked at the port. Each test arranges what "Meta" says. */
class FakeEmbeddedSignup extends EmbeddedSignupPort {
  grant: EmbeddedSignupGrant = {
    valid: true,
    managementWabaIds: [],
    messagingWabaIds: [],
    metaUserId: null,
  };
  numbers: EmbeddedSignupPhoneNumber[] = [];
  registerFailure: EmbeddedSignupError | null = null;
  readonly calls: string[] = [];

  exchangeCode(code: string): Promise<string> {
    this.calls.push(`exchange:${code}`);
    if (code === 'used-code') {
      return Promise.reject(new EmbeddedSignupError('invalid_code', 'used'));
    }
    return Promise.resolve(`EAAG-business-token-${code}`);
  }
  inspectGrant(): Promise<EmbeddedSignupGrant> {
    return Promise.resolve(this.grant);
  }
  listPhoneNumbers(): Promise<EmbeddedSignupPhoneNumber[]> {
    return Promise.resolve(this.numbers);
  }
  subscribeApp(wabaId: string): Promise<void> {
    this.calls.push(`subscribe:${wabaId}`);
    return Promise.resolve();
  }
  registerPhoneNumber(phoneNumberId: string): Promise<void> {
    this.calls.push(`register:${phoneNumberId}`);
    return this.registerFailure
      ? Promise.reject(this.registerFailure)
      : Promise.resolve();
  }

  arrange(wabaId: string, phoneNumberId: string): void {
    this.grant = {
      valid: true,
      managementWabaIds: [wabaId],
      messagingWabaIds: [wabaId],
      metaUserId: `meta-user-${wabaId}`,
    };
    this.numbers = [
      {
        id: phoneNumberId,
        displayPhoneNumber: '+1 555-010-0000',
        isOnBizApp: false,
      },
    ];
    this.registerFailure = null;
    this.calls.length = 0;
  }
}

function numericId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

describe('WhatsApp connect (Gulf T3: Embedded Signup, D16)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let httpServer: INestApplication;
  let jwtSecret: string;
  let connection: WhatsappConnectionService;
  let encryption: BspCredentialsEncryptionService;
  const meta = new FakeEmbeddedSignup();

  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  const trialTenantId = randomUUID();
  const otherTenantId = randomUUID();
  const planId = randomUUID();
  const phoneNumberId = `pnid-${randomUUID()}`;
  const accessToken = `EAAG-secret-${randomUUID()}`;
  let connectedNumberId: string;

  function adminToken(tenantId: string): string {
    return signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });
  }

  async function rowFor(pnid: string) {
    const rows = await persistence.runAdminQuery((db) =>
      db
        .select()
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.phoneNumberId, pnid)),
    );
    return rows[0];
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        BillingModule,
        ConnectModule,
      ],
    })
      .overrideProvider(EmbeddedSignupPort)
      .useValue(meta)
      .compile();

    persistence = moduleRef.get(PersistenceService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;
    connection = moduleRef.get(WhatsappConnectionService);
    encryption = moduleRef.get(BspCredentialsEncryptionService);

    await persistence.runMigrations();

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: trialTenantId, name: 'Connect Test Tenant (trial, no card)' },
        { id: otherTenantId, name: 'Connect Test Tenant (other)' },
      ]),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(plans).values({
        id: planId,
        name: 'Pro',
        stripePriceId: 'price_test_connect',
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      }),
    );
    // D16: the trial tenant has NO Stripe subscription (no card on file),
    // exactly the tenant the old D7 gate refused.
    const tenantContext = moduleRef.get(TenantContextService);
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantSubscriptions).values({
          tenantId: trialTenantId,
          planId,
          status: 'trialing',
          trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
        }),
      trialTenantId,
    );

    httpServer = moduleRef.createNestApplication();
    await httpServer.init();
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db
        .delete(whatsappNumbers)
        .where(
          inArray(whatsappNumbers.tenantId, [trialTenantId, otherTenantId]),
        ),
    );
    await persistence.runAdminQuery((db) =>
      db
        .delete(tenants)
        .where(inArray(tenants.id, [trialTenantId, otherTenantId])),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(plans).where(eq(plans.id, planId)),
    );
    await httpServer.close();
  });

  describe('POST /whatsapp/connect/embedded-signup', () => {
    it('connects a number for a trialing tenant with no card (D16), storing {accessToken, wabaId, pin} encrypted as active', async () => {
      const wabaId = numericId();
      const pnid = numericId();
      meta.arrange(wabaId, pnid);

      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'fresh-code', wabaId, phoneNumberId: pnid })
        .expect(201);

      expect(response.body).toMatchObject({
        phoneNumberId: pnid,
        connectionState: 'active',
        connectionError: null,
        coexistence: false,
      });
      expect(JSON.stringify(response.body)).not.toContain('EAAG');
      expect(meta.calls).toEqual([
        'exchange:fresh-code',
        `subscribe:${wabaId}`,
        `register:${pnid}`,
      ]);

      const row = await rowFor(pnid);
      expect(row.tenantId).toBe(trialTenantId);
      expect(row.connectionState).toBe('active');
      expect(row.bspCredentialsEncrypted).not.toContain('EAAG');
      const credentials = encryption.decrypt(row.bspCredentialsEncrypted);
      expect(credentials).toMatchObject({
        accessToken: 'EAAG-business-token-fresh-code',
        wabaId,
      });
      expect(credentials.pin).toMatch(/^\d{6}$/);
      // Gulf T5: what the WABA webhooks and the deauthorize callback key on.
      expect(row.wabaId).toBe(wabaId);
      expect(row.displayPhoneNumber).toBe('15550100000');
      expect(row.connectedByMetaUserHash).toBe(
        hashMetaUserId(`meta-user-${wabaId}`),
      );
    });

    it('stores a number whose register fails after subscribe as reconnect_required, never active', async () => {
      const wabaId = numericId();
      const pnid = numericId();
      meta.arrange(wabaId, pnid);
      meta.registerFailure = new EmbeddedSignupError('pin_mismatch', '133005');

      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'c2', wabaId, phoneNumberId: pnid })
        .expect(201);

      const stored = response.body as {
        connectionState: string;
        connectionError: string | null;
      };
      expect(stored.connectionState).toBe('reconnect_required');
      expect(stored.connectionError).toMatch(/two-step verification/);
      const row = await rowFor(pnid);
      expect(row.connectionState).toBe('reconnect_required');

      const listed = await request(server())
        .get('/whatsapp/connect/numbers')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .expect(200);
      expect(listed.body).toContainEqual(
        expect.objectContaining({
          phoneNumberId: pnid,
          connectionState: 'reconnect_required',
        }),
      );

      // Reconnecting with the tenant's own PIN clears it back to active.
      meta.registerFailure = null;
      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'c3', wabaId, phoneNumberId: pnid, pin: '246810' })
        .expect(201);
      const fixed = await rowFor(pnid);
      expect(fixed.connectionState).toBe('active');
      expect(fixed.connectionError).toBeNull();
      expect(encryption.decrypt(fixed.bspCredentialsEncrypted).pin).toBe(
        '246810',
      );
    });

    it('403s and stores nothing when the WABA was not granted to the token', async () => {
      const wabaId = numericId();
      const pnid = numericId();
      meta.arrange(wabaId, pnid);
      meta.grant = {
        valid: true,
        managementWabaIds: ['1'],
        messagingWabaIds: ['1'],
        metaUserId: null,
      };

      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'c4', wabaId, phoneNumberId: pnid })
        .expect(403);
      expect(await rowFor(pnid)).toBeUndefined();
      expect(meta.calls).toEqual(['exchange:c4']);
    });

    it('403s and stores nothing when the number is not on the WABA', async () => {
      const wabaId = numericId();
      meta.arrange(wabaId, numericId());
      const foreign = numericId();

      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'c5', wabaId, phoneNumberId: foreign })
        .expect(403);
      expect(await rowFor(foreign)).toBeUndefined();
    });

    it('409s before any Graph write when another tenant holds the number, leaving the row untouched', async () => {
      const wabaId = numericId();
      const pnid = numericId();
      meta.arrange(wabaId, pnid);
      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'owner', wabaId, phoneNumberId: pnid })
        .expect(201);

      meta.calls.length = 0;
      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(otherTenantId)}`)
        .send({ code: 'hijack', wabaId, phoneNumberId: pnid })
        .expect(409);
      expect(meta.calls).toEqual(['exchange:hijack']);
      const row = await rowFor(pnid);
      expect(row.tenantId).toBe(trialTenantId);
      expect(encryption.decrypt(row.bspCredentialsEncrypted).accessToken).toBe(
        'EAAG-business-token-owner',
      );
    });

    it('400s a reused code', async () => {
      const wabaId = numericId();
      meta.arrange(wabaId, numericId());
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .send({ code: 'used-code', wabaId })
        .expect(400);
      expect((response.body as { message: string }).message).toMatch(
        /already used or has expired/,
      );
    });

    it('401s without a bearer token and 403s an agent-role token', async () => {
      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .send({ code: 'x', wabaId: '1' })
        .expect(401);
      await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set(
          'Authorization',
          `Bearer ${signToken(jwtSecret, { sub: randomUUID(), tenantId: trialTenantId, appRole: 'agent' })}`,
        )
        .send({ code: 'x', wabaId: '1' })
        .expect(403);
    });
  });

  describe('ConnectStateService (kept)', () => {
    it('round-trips a tenant-bound state and rejects a forged one', () => {
      const state = moduleRef.get(ConnectStateService);
      expect(state.verify(state.sign(trialTenantId))).toEqual({
        tenantId: trialTenantId,
      });
      expect(() => state.verify('not-a-real-signed-state')).toThrow(
        InvalidConnectStateError,
      );
    });
  });

  describe('WhatsappConnectionService.connectNumber', () => {
    it('stores the credential encrypted, never in plaintext, active by default', async () => {
      const connected = await connection.connectNumber(
        trialTenantId,
        phoneNumberId,
        { accessToken },
      );
      connectedNumberId = connected.id;
      expect(connected).toMatchObject({
        phoneNumberId,
        connectionState: 'active',
        connectionError: null,
      });

      const row = await rowFor(phoneNumberId);
      expect(row.bspCredentialsEncrypted).not.toContain(accessToken);
    });

    it('re-connecting the same number for the same tenant updates in place', async () => {
      const again = await connection.connectNumber(
        trialTenantId,
        phoneNumberId,
        { accessToken: `${accessToken}-rotated` },
      );
      expect(again.id).toBe(connectedNumberId);
    });

    it('refuses to reassign a number owned by a different tenant (hijack guard)', async () => {
      await expect(
        connection.connectNumber(otherTenantId, phoneNumberId, {
          accessToken: 'attacker-token',
        }),
      ).rejects.toBeInstanceOf(ChannelOwnedByAnotherTenantError);
      expect((await rowFor(phoneNumberId)).tenantId).toBe(trialTenantId);
      await expect(
        connection.isConnectedToAnotherTenant(otherTenantId, phoneNumberId),
      ).resolves.toBe(true);
      await expect(
        connection.isConnectedToAnotherTenant(trialTenantId, phoneNumberId),
      ).resolves.toBe(false);
    });

    it('rejects a connection_state outside the D5 enum at the database', async () => {
      await expect(
        persistence.runAdminQuery((db) =>
          db
            .update(whatsappNumbers)
            .set({ connectionState: 'bogus' as never })
            .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId)),
        ),
      ).rejects.toThrow();
    });
  });

  describe('GET /whatsapp/connect/numbers', () => {
    it("lists the tenant's own numbers with state, never the credential", async () => {
      const response = await request(server())
        .get('/whatsapp/connect/numbers')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .expect(200);

      // Gulf T5 made the item wider (health fields, all null until reported).
      expect(response.body).toContainEqual(
        expect.objectContaining({
          id: connectedNumberId,
          phoneNumberId,
          connectionState: 'active',
          connectionError: null,
          qualityRating: null,
          messagingLimitTier: null,
          nameStatus: null,
          paymentMethodAttached: null,
          lastHealthCheckAt: null,
          healthIssues: [],
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain('EAAG');
    });

    it("does not let tenant B see tenant A's numbers", async () => {
      const response = await request(server())
        .get('/whatsapp/connect/numbers')
        .set('Authorization', `Bearer ${adminToken(otherTenantId)}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('requires a bearer token', async () => {
      await request(server()).get('/whatsapp/connect/numbers').expect(401);
    });
  });

  describe('removed 360dialog routes (D14)', () => {
    it('GET /whatsapp/connect/start is gone', async () => {
      await request(server())
        .get('/whatsapp/connect/start')
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .expect(404);
    });

    it('GET /whatsapp/connect/callback is gone', async () => {
      await request(server())
        .get('/whatsapp/connect/callback')
        .query({ state: 'x', client_id: 'y', channels: 'z' })
        .expect(404);
    });

    it('POST /whatsapp/connect/numbers/:id/regenerate-key is gone', async () => {
      await request(server())
        .post(`/whatsapp/connect/numbers/${connectedNumberId}/regenerate-key`)
        .set('Authorization', `Bearer ${adminToken(trialTenantId)}`)
        .expect(404);
    });
  });
});
