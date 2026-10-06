// Gulf T5 (D5): WhatsApp number health, end to end against real Postgres.
//
// What only a database can prove, and so is proven here:
//   - a WABA webhook (account_update / phone_number_quality_update /
//     phone_number_name_update, Meta's documented bodies) changes exactly the
//     numbers on that WABA, and the name update only the matching number;
//   - the connection-state policy holds in SQL: a restriction never
//     replaces a more severe state;
//   - a send Meta refuses with 401 / code 190 leaves the number
//     `reconnect_required`, and the original error still reaches the caller;
//   - the reconcile stores Meta's health fields + last_health_check_at,
//     backfills waba_id on a legacy row, and degrades a dead token;
//   - the tenant read (`GET /whatsapp/connect/numbers`'s source) returns the
//     health fields in the documented shape, for its own tenant only.
//
// Meta is faked at MetaGraphClient; everything else is real. Runs via
// `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { AppLoggerService, Clock } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  MetaGraphClient,
  MetaGraphError,
} from '../../src/modules/meta-graph/meta-graph.module';
import {
  tenants,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { BspCredentialsEncryptionService } from '../../src/modules/whatsapp/bsp-credentials-encryption.service';
import { BspCredentialsService } from '../../src/modules/whatsapp/bsp-credentials.service';
import { MetaPhoneNumberHealthReader } from '../../src/modules/whatsapp/health/meta-phone-number-health.reader';
import { WabaHealthWebhookService } from '../../src/modules/whatsapp/health/waba-health-webhook.service';
import { WhatsappHealthReconcileService } from '../../src/modules/whatsapp/health/whatsapp-health-reconcile.service';
import { WhatsappNumberHealthStore } from '../../src/modules/whatsapp/health/whatsapp-number-health.store';
import { MetaCloudAdapter } from '../../src/modules/whatsapp/meta-cloud.adapter';
import { WhatsappNumberDirectory } from '../../src/modules/whatsapp/whatsapp-number-directory.service';
import { WhatsappModule } from '../../src/modules/whatsapp/whatsapp.module';

const NOW = new Date('2026-09-19T03:00:00.000Z');

describe('WhatsApp number health (Gulf T5, D5)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let encryption: BspCredentialsEncryptionService;
  let webhook: WabaHealthWebhookService;
  let directory: WhatsappNumberDirectory;
  let adapter: MetaCloudAdapter;
  let reconcile: WhatsappHealthReconcileService;

  const graph = { get: jest.fn(), post: jest.fn(), getBinary: jest.fn() };

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const wabaW = digits();
  const wabaOther = digits();
  const pnA1 = `pn-${randomUUID()}`;
  const pnA2 = `pn-${randomUUID()}`;
  const pnOther = `pn-${randomUUID()}`;
  const pnLegacy = `pn-${randomUUID()}`;
  const displayA1 = '15550001111';
  const displayA2 = '15550002222';

  function wabaWebhook(field: string, value: unknown, entryId = wabaW) {
    return Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: entryId, time: 1758276000, changes: [{ field, value }] }],
      }),
    );
  }

  async function row(phoneNumberId: string) {
    const [found] = await persistence.runAdminQuery((db) =>
      db
        .select()
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId)),
    );
    return found;
  }

  async function setState(phoneNumberIds: string[], state: 'active') {
    await persistence.runAdminQuery((db) =>
      db
        .update(whatsappNumbers)
        .set({ connectionState: state, connectionError: null })
        .where(inArray(whatsappNumbers.phoneNumberId, phoneNumberIds)),
    );
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WhatsappModule,
      ],
    })
      .overrideProvider(MetaGraphClient)
      .useValue(graph)
      .compile();
    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    encryption = moduleRef.get(BspCredentialsEncryptionService);
    webhook = moduleRef.get(WabaHealthWebhookService);
    directory = moduleRef.get(WhatsappNumberDirectory);
    adapter = moduleRef.get(MetaCloudAdapter);
    reconcile = new WhatsappHealthReconcileService(
      moduleRef.get(WhatsappNumberHealthStore),
      moduleRef.get(BspCredentialsService),
      new MetaPhoneNumberHealthReader(graph as unknown as MetaGraphClient),
      { now: () => NOW } as Clock,
      moduleRef.get(AppLoggerService),
    );

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Health Tenant A' },
        { id: tenantB, name: 'Health Tenant B' },
      ]),
    );
    const creds = (wabaId?: string) =>
      encryption.encrypt({
        accessToken: 'EAAG-test',
        ...(wabaId ? { wabaId } : {}),
      });
    await persistence.runAdminQuery((db) =>
      db.insert(whatsappNumbers).values([
        {
          tenantId: tenantA,
          phoneNumberId: pnA1,
          bspCredentialsEncrypted: creds(wabaW),
          wabaId: wabaW,
          displayPhoneNumber: displayA1,
        },
        {
          tenantId: tenantA,
          phoneNumberId: pnA2,
          bspCredentialsEncrypted: creds(wabaW),
          wabaId: wabaW,
          displayPhoneNumber: displayA2,
        },
        {
          tenantId: tenantB,
          phoneNumberId: pnOther,
          bspCredentialsEncrypted: creds(wabaOther),
          wabaId: wabaOther,
        },
        {
          // Connected before T5: waba_id only inside the encrypted blob.
          tenantId: tenantB,
          phoneNumberId: pnLegacy,
          bspCredentialsEncrypted: creds(wabaOther),
        },
      ]),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    await moduleRef.close();
  });

  beforeEach(() => {
    graph.get.mockReset();
    graph.post.mockReset();
  });

  describe('WABA webhooks', () => {
    afterEach(() => setState([pnA1, pnA2, pnOther, pnLegacy], 'active'));

    it('ACCOUNT_RESTRICTION restricts every number on that WABA and nothing else', async () => {
      await webhook.apply(
        wabaWebhook('account_update', {
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [
            {
              restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
              expiration: 1641330498,
            },
          ],
        }),
      );

      expect((await row(pnA1)).connectionState).toBe('restricted');
      expect((await row(pnA2)).connectionState).toBe('restricted');
      expect((await row(pnA1)).connectionError).toMatch(/restricted/);
      expect((await row(pnOther)).connectionState).toBe('active');
    });

    it('never softens a more severe state, and a redelivery is a no-op', async () => {
      const deleted = wabaWebhook('account_update', {
        event: 'ACCOUNT_DELETED',
      });
      await webhook.apply(deleted);
      await webhook.apply(
        wabaWebhook('account_update', {
          event: 'ACCOUNT_RESTRICTION',
          restriction_info: [],
        }),
      );
      await webhook.apply(deleted);

      expect((await row(pnA1)).connectionState).toBe('disconnected');
    });

    it("PARTNER_APP_UNINSTALLED for our app, keyed by waba_info (Meta's documented shape)", async () => {
      await webhook.apply(
        wabaWebhook(
          'account_update',
          {
            event: 'PARTNER_APP_UNINSTALLED',
            // META_APP_ID is unset here, so our app id is '' and a present
            // partner_app_id cannot match: omit it (Meta's docs mark it
            // present, so the id check is covered by the unit spec).
            waba_info: { waba_id: wabaOther, owner_business_id: '1' },
          },
          'partner-business-id',
        ),
      );

      expect((await row(pnOther)).connectionState).toBe('reconnect_required');
      expect((await row(pnA1)).connectionState).toBe('active');
    });

    it('stores a messaging-limit change on the whole WABA and a name decision on the matching number only', async () => {
      await webhook.apply(
        wabaWebhook('phone_number_quality_update', {
          display_phone_number: displayA1,
          event: 'UPGRADE',
          max_daily_conversations_per_business: 'TIER_10K',
        }),
      );
      await webhook.apply(
        wabaWebhook('phone_number_name_update', {
          display_phone_number: displayA2,
          decision: 'REJECTED',
          requested_verified_name: 'Lucky Shrub',
          rejection_reason: 'NAME_FORMAT_UNACCEPTABLE',
        }),
      );

      expect((await row(pnA1)).messagingLimitTier).toBe('TIER_10K');
      expect((await row(pnA2)).messagingLimitTier).toBe('TIER_10K');
      expect((await row(pnOther)).messagingLimitTier).toBeNull();
      expect((await row(pnA2)).nameStatus).toBe('DECLINED');
      expect((await row(pnA1)).nameStatus).toBeNull();
    });
  });

  describe('send path (critical regression #2 stays intact)', () => {
    afterEach(() => setState([pnA1], 'active'));

    it('a 401 / code 190 on a send marks the number reconnect_required and still throws', async () => {
      graph.post.mockRejectedValue(
        new MetaGraphError(401, 190, 463, 'Error validating access token'),
      );

      await expect(
        adapter.sendTextMessage({ phoneNumberId: pnA1, to: '1', body: 'hi' }),
      ).rejects.toBeInstanceOf(MetaGraphError);

      const after = await row(pnA1);
      expect(after.connectionState).toBe('reconnect_required');
      expect(after.connectionError).toMatch(/Connect the number again/);
    });

    it('a successful send changes nothing', async () => {
      graph.post.mockResolvedValue({ messages: [{ id: 'wamid.OK' }] });
      await expect(
        adapter.sendTextMessage({ phoneNumberId: pnA1, to: '1', body: 'hi' }),
      ).resolves.toEqual({ bspMessageId: 'wamid.OK' });
      expect((await row(pnA1)).connectionState).toBe('active');
    });
  });

  describe('daily reconcile', () => {
    afterEach(() => setState([pnA1, pnA2, pnOther, pnLegacy], 'active'));

    it("stores Meta's health, backfills a legacy row's waba_id, and degrades a dead token", async () => {
      graph.get.mockImplementation((path: string) => {
        if (path === pnA2) {
          return Promise.reject(new MetaGraphError(401, 190, 460, 'expired'));
        }
        if (path === wabaW || path === wabaOther) {
          return Promise.resolve({ id: path, primary_funding_id: '555' });
        }
        return Promise.resolve({
          id: path,
          display_phone_number: '+1 555-000-9999',
          verified_name: 'Lucky Shrub',
          quality_rating: 'YELLOW',
          name_status: 'APPROVED',
          whatsapp_business_manager_messaging_limit: 'TIER_2K',
          health_status: { can_send_message: 'AVAILABLE', entities: [] },
        });
      });

      const summary = await reconcile.reconcileAll();

      expect(summary.reconnectRequired).toBeGreaterThanOrEqual(1);
      const a1 = await row(pnA1);
      expect(a1).toMatchObject({
        qualityRating: 'YELLOW',
        messagingLimitTier: 'TIER_2K',
        nameStatus: 'APPROVED',
        verifiedName: 'Lucky Shrub',
        paymentMethodAttached: true,
        messagingHealth: 'AVAILABLE',
        healthIssues: [],
        connectionState: 'active',
      });
      expect(a1.lastHealthCheckAt?.toISOString()).toBe(NOW.toISOString());

      const legacy = await row(pnLegacy);
      expect(legacy.wabaId).toBe(wabaOther);
      expect(legacy.lastHealthCheckAt).not.toBeNull();

      const a2 = await row(pnA2);
      expect(a2.connectionState).toBe('reconnect_required');
      expect(a2.lastHealthCheckAt).toBeNull();
    });

    it("restricts a BLOCKED number with Meta's reason, then restores it once Meta says it can send", async () => {
      const blocked = {
        quality_rating: 'GREEN',
        health_status: {
          can_send_message: 'BLOCKED',
          entities: [
            {
              entity_type: 'WABA',
              can_send_message: 'BLOCKED',
              errors: [
                {
                  error_code: 141006,
                  error_description:
                    'There is an error with the payment method.',
                  possible_solution: 'Add a valid payment method.',
                },
              ],
            },
          ],
        },
      };
      graph.get.mockImplementation((path: string) =>
        Promise.resolve(path.startsWith('pn-') ? blocked : { id: path }),
      );
      await reconcile.reconcileAll();

      const restricted = await row(pnA1);
      expect(restricted.connectionState).toBe('restricted');
      expect(restricted.connectionError).toContain('payment method');
      expect(restricted.paymentMethodAttached).toBe(false);
      expect(restricted.healthIssues).toHaveLength(1);

      graph.get.mockImplementation((path: string) =>
        Promise.resolve(
          path.startsWith('pn-')
            ? { health_status: { can_send_message: 'AVAILABLE', entities: [] } }
            : { id: path, primary_funding_id: '1' },
        ),
      );
      await reconcile.reconcileAll();
      expect((await row(pnA1)).connectionState).toBe('active');
    });
  });

  it("the tenant read returns health fields in the API shape, for the caller's tenant only", async () => {
    const numbers = await directory.listForTenant(tenantA);

    expect(numbers.map((n) => n.phoneNumberId).sort()).toEqual(
      [pnA1, pnA2].sort(),
    );
    const a1 = numbers.find((n) => n.phoneNumberId === pnA1)!;
    expect(Object.keys(a1).sort()).toEqual(
      [
        'connectionError',
        'connectionState',
        'displayPhoneNumber',
        'healthIssues',
        'id',
        'lastHealthCheckAt',
        'messagingHealth',
        'messagingLimitTier',
        'nameStatus',
        'paymentMethodAttached',
        'phoneNumberId',
        'qualityRating',
        'verifiedName',
      ].sort(),
    );
    expect(typeof a1.lastHealthCheckAt).toBe('string');
    expect(JSON.stringify(numbers)).not.toContain('EAAG-test');
  });
});
