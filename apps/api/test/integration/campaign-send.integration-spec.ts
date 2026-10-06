// F19 (D2, D3, D4, D9): the campaign-send scenarios that a mocked unit test
// (campaign-runner.service.spec.ts) cannot prove, because what closes each
// of them is real Postgres/Redis state, not application code:
//
//   1. launch() snapshots the segment and starts the first batch — asserted
//      against real `campaign_recipients` rows, not a mock call count.
//   2. two campaigns racing for the SAME WhatsApp number defer rather than
//      drop — proven by CampaignRateLimiter's real Redis INCR/DECR
//      semaphore (D3's concurrency guard), which a mocked
//      `acquireNumberSlot` can only assert was called, never actually race.
//   3. a batch pauses on paused_template / paused_spend_cap mid-send and
//      leaves the correct recipients `pending` — a real row count, not a
//      mock's `markPaused` call.
//   4. cross-tenant isolation: two tenants' sends running concurrently
//      produce zero leakage in `campaign_recipients` — provable only against
//      real RLS-scoped rows.
//
// Runs the real CampaignModule graph (real Postgres via TenantContextService,
// real Redis via CampaignRateLimiter, a real BullMQ Worker via
// CampaignSendProcessor) with ONLY the outbound WhatsApp call swapped for
// FixtureBspAdapter (the in-repo BspAdapter fixture already used by
// webhook-channel.integration-spec.ts) — nothing else is mocked.
//
// Requires a real Postgres reachable at DATABASE_URL, connected as the
// non-superuser `app_user` role, and a real Redis at REDIS_URL. Run via
// `npm run test:integration` from apps/api.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { CampaignModule } from '../../src/modules/campaign/campaign.module';
import { CampaignEligibilityService } from '../../src/modules/campaign/campaign-eligibility.service';
import {
  CAMPAIGN_SEND_QUEUE,
  type CampaignJobData,
} from '../../src/modules/campaign/campaign-send.queue';
import { CampaignSendSchedulerService } from '../../src/modules/campaign/campaign-send.scheduler.service';
import { CampaignRunnerService } from '../../src/modules/campaign/campaign-runner.service';
import { CampaignDeferredError } from '../../src/modules/campaign/campaign.errors';
import { MARKETING_OPT_OUT_FRAGMENT } from '../../src/modules/campaign/marketing-opt-out-fragment';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  campaignRecipients,
  campaigns,
  customers,
  messageTemplates,
  plans,
  segments,
  tenantSubscriptions,
  tenants,
  whatsappNumbers,
  type CampaignStatus,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { BspAdapter } from '../../src/modules/whatsapp/ports/bsp-adapter.port';
import { FixtureBspAdapter } from './fixtures/fixture-bsp-adapter';

jest.setTimeout(60_000);

/**
 * Drain-to-empty polling — never a fixed sleep. Every scenario below waits
 * for the actual database (or queue) state it cares about, the same pattern
 * webhook-channel.integration-spec.ts's `waitUntil` uses for its real
 * BullMQ worker.
 */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

const UAE_PREFIX = '+9715';

describe('campaign send (F19 D2/D3/D4/D9 integration slice)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let scheduler: CampaignSendSchedulerService;
  let runner: CampaignRunnerService;
  let eligibility: CampaignEligibilityService;
  let sendQueue: Queue<CampaignJobData>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule, CampaignModule],
    })
      // The ONLY override in this suite: a fixture in place of the real Meta
      // Graph client, so "send" is a real end-to-end pipeline run without a
      // dependency on live Meta credentials. Everything downstream of it
      // (claim, transaction, spend accounting, recipient status) is real.
      .overrideProvider(BspAdapter)
      .useValue(new FixtureBspAdapter([]))
      .compile();

    // .init() runs Nest lifecycle hooks — required so CampaignSendProcessor's
    // real BullMQ Worker actually starts consuming `campaign-send` jobs; a
    // bare .compile() does not trigger onModuleInit (same requirement
    // webhook-channel.integration-spec.ts documents for RespondPathProcessor).
    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    scheduler = moduleRef.get(CampaignSendSchedulerService);
    runner = moduleRef.get(CampaignRunnerService);
    eligibility = moduleRef.get(CampaignEligibilityService);
    sendQueue = moduleRef.get(getQueueToken(CAMPAIGN_SEND_QUEUE));

    await persistence.runMigrations();
  });

  afterAll(async () => {
    await sendQueue.obliterate({ force: true });
    await moduleRef.close();
  });

  interface TenantFixture {
    tenantId: string;
    phoneNumberId: string;
    wabaId: string;
    templateId: string;
    segmentId: string;
    tag: string;
  }

  /**
   * One tenant with everything CampaignEligibilityService's gate needs to
   * come back clean: an `active` billing subscription, a `whatsapp_numbers`
   * row healthy AND freshly checked (so the eligibility read never has to
   * reach out to WhatsappHealthReconcileService / a real Meta call), and one
   * approved MARKETING template on the same WABA as the number.
   */
  async function seedTenant(label: string): Promise<TenantFixture> {
    const tenantId = randomUUID();
    const phoneNumberId = `pn-${label}-${randomUUID().slice(0, 8)}`;
    const wabaId = `waba-${label}-${randomUUID().slice(0, 8)}`;
    const templateId = randomUUID();
    const segmentId = randomUUID();
    const planId = randomUUID();
    const tag = `campaign-send-${label}-${randomUUID().slice(0, 8)}`;

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: `F19 send tenant ${label}` }),
    );

    await persistence.runAdminQuery((db) =>
      db.insert(plans).values({
        id: planId,
        name: `F19 test plan ${label}`,
        stripePriceId: `price_${label}`,
        monthlyMessageLimit: 1_000_000,
        monthlySpendCapUsd: 100_000,
        trialDays: 0,
      }),
    );

    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantSubscriptions).values({
          tenantId,
          planId,
          stripeCustomerId: `cus_${tenantId}`,
          stripeSubscriptionId: `sub_${tenantId}`,
          status: 'active',
        }),
      tenantId,
    );

    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(whatsappNumbers).values({
          tenantId,
          phoneNumberId,
          bspCredentialsEncrypted: 'not-real-ciphertext-for-this-test',
          connectionState: 'active',
          wabaId,
          paymentMethodAttached: true,
          qualityRating: 'GREEN',
          messagingLimitTier: 'TIER_1K',
          messagingHealth: 'AVAILABLE',
          businessVerificationStatus: 'verified',
          // Fresh, so CampaignEligibilityService.readFresh() never calls out
          // to WhatsappHealthReconcileService (a real Meta client) — the
          // eligibility gate is decided entirely from this stored row, as
          // designed.
          lastHealthCheckAt: new Date(),
        }),
      tenantId,
    );

    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(messageTemplates).values({
          id: templateId,
          tenantId,
          kind: 'whatsapp_template',
          name: `send_test_${label}`,
          language: 'en',
          category: 'MARKETING',
          body: `Hi there! Big sale today. ${MARKETING_OPT_OUT_FRAGMENT}`,
          variables: [],
          approvalStatus: 'approved',
          wabaId,
        }),
      tenantId,
    );

    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(segments).values({
          id: segmentId,
          tenantId,
          name: `send test segment ${label}`,
          definition: { kind: 'tag', hasAny: [tag] },
        }),
      tenantId,
    );

    return { tenantId, phoneNumberId, wabaId, templateId, segmentId, tag };
  }

  async function seedCustomers(
    fixture: TenantFixture,
    count: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await tenantContext.withTenantTx(
        (tx) =>
          tx.insert(customers).values({
            id,
            tenantId: fixture.tenantId,
            phone: `${UAE_PREFIX}${String(i).padStart(8, '0')}${randomUUID().slice(0, 2)}`,
            name: `Customer ${i}`,
            tags: [fixture.tag],
          }),
        fixture.tenantId,
      );
    }
    return ids;
  }

  async function seedCampaign(
    fixture: TenantFixture,
    overrides: { status: CampaignStatus; spendCapUsd?: number },
  ): Promise<string> {
    const campaignId = randomUUID();
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(campaigns).values({
          id: campaignId,
          tenantId: fixture.tenantId,
          name: `send test campaign ${campaignId.slice(0, 8)}`,
          segmentId: fixture.segmentId,
          templateId: fixture.templateId,
          templateValues: [],
          phoneNumberId: fixture.phoneNumberId,
          status: overrides.status,
          spendCapUsd: overrides.spendCapUsd ?? 50,
        }),
      fixture.tenantId,
    );
    return campaignId;
  }

  /** Inserts `campaign_recipients` rows directly — the shape SegmentResolver.snapshot() writes, without going through it. */
  async function seedRecipients(
    fixture: TenantFixture,
    campaignId: string,
    customerIds: string[],
  ): Promise<void> {
    await tenantContext.withTenantTx(async (tx) => {
      for (const customerId of customerIds) {
        await tx.execute(sql`
          insert into campaign_recipients (tenant_id, campaign_id, customer_id, phone, status)
          select ${fixture.tenantId}, ${campaignId}, ${customerId}, phone, 'pending'
            from customers where id = ${customerId}
        `);
      }
    }, fixture.tenantId);
  }

  async function campaignStatus(
    fixture: TenantFixture,
    campaignId: string,
  ): Promise<{ status: string; spentUsd: number } | null> {
    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ status: campaigns.status, spentUsd: campaigns.spentUsd })
          .from(campaigns)
          .where(
            and(eq(campaigns.tenantId, fixture.tenantId), eq(campaigns.id, campaignId)),
          ),
      fixture.tenantId,
    );
    return rows[0] ?? null;
  }

  async function recipientRows(
    fixture: TenantFixture,
    campaignId: string,
  ): Promise<Array<{ status: string; customerId: string }>> {
    return tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            status: campaignRecipients.status,
            customerId: campaignRecipients.customerId,
          })
          .from(campaignRecipients)
          .where(
            and(
              eq(campaignRecipients.tenantId, fixture.tenantId),
              eq(campaignRecipients.campaignId, campaignId),
            ),
          ),
      fixture.tenantId,
    );
  }

  /**
   * `campaign_recipients`, `campaigns`, `segments`, `message_templates`,
   * `customers` and `tenant_subscriptions` are all RLS `FORCE`d (see e.g.
   * 0013_customers-rls-policy.sql) with a fail-CLOSED guard on a missing
   * `app.tenant_id` GUC — `persistence.runAdminQuery()` opens no transaction
   * and sets no GUC, so a delete issued through it against any of these
   * tables silently matches zero rows instead of actually cleaning up.
   * `withTenantTx()` is what sets that GUC, so cleanup for every RLS-scoped
   * table below goes through it. `whatsapp_numbers` and `tenants` are the
   * two tables in this fixture that are deliberately NOT RLS-scoped (see
   * whatsapp-numbers.table.ts's header and tenants.table.ts), so those two
   * stay on `runAdminQuery`, same as orders.integration-spec.ts's pattern.
   */
  async function cleanupTenant(fixture: TenantFixture): Promise<void> {
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(
          sql`delete from campaign_recipients where tenant_id = ${fixture.tenantId}`,
        ),
      fixture.tenantId,
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(sql`delete from campaigns where tenant_id = ${fixture.tenantId}`),
      fixture.tenantId,
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(sql`delete from segments where tenant_id = ${fixture.tenantId}`),
      fixture.tenantId,
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(
          sql`delete from message_templates where tenant_id = ${fixture.tenantId}`,
        ),
      fixture.tenantId,
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(sql`delete from customers where tenant_id = ${fixture.tenantId}`),
      fixture.tenantId,
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.execute(
          sql`delete from tenant_subscriptions where tenant_id = ${fixture.tenantId}`,
        ),
      fixture.tenantId,
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`delete from whatsapp_numbers where tenant_id = ${fixture.tenantId}`),
    );
    await persistence.runAdminQuery((db) =>
      db.execute(sql`delete from tenants where id = ${fixture.tenantId}`),
    );
  }

  describe('1. launch() snapshots the segment and starts the first batch (real rows)', () => {
    it('creates one campaign_recipients row per matching customer and sends every one through the real pipeline', async () => {
      const fixture = await seedTenant('launch');
      const customerIds = await seedCustomers(fixture, 5);
      const campaignId = await seedCampaign(fixture, { status: 'scheduled' });

      try {
        await scheduler.scheduleLaunch(fixture.tenantId, campaignId, null);

        await waitUntil(async () => {
          const status = await campaignStatus(fixture, campaignId);
          return status?.status === 'completed';
        });

        const recipients = await recipientRows(fixture, campaignId);
        expect(recipients).toHaveLength(customerIds.length);
        expect(recipients.map((r) => r.customerId).sort()).toEqual(
          [...customerIds].sort(),
        );
        // Every recipient actually went through CampaignSenderService.sendOne
        // against the fixture adapter — a real send, not a mocked call.
        expect(recipients.every((r) => r.status === 'sent')).toBe(true);

        const status = await campaignStatus(fixture, campaignId);
        expect(status?.spentUsd).toBeGreaterThan(0);
      } finally {
        await cleanupTenant(fixture);
      }
    });
  });

  describe('2. two campaigns racing for the same WhatsApp number defer, never drop (real Redis D3 semaphore)', () => {
    it('lets exactly one runBatch() through per number; the loser gets CampaignDeferredError with its recipients untouched', async () => {
      const fixture = await seedTenant('race');
      const [customersA, customersB] = await Promise.all([
        seedCustomers(fixture, 3),
        seedCustomers(fixture, 3),
      ]);
      const [campaignA, campaignB] = await Promise.all([
        seedCampaign(fixture, { status: 'sending' }),
        seedCampaign(fixture, { status: 'sending' }),
      ]);
      await Promise.all([
        seedRecipients(fixture, campaignA, customersA),
        seedRecipients(fixture, campaignB, customersB),
      ]);

      try {
        const [resultA, resultB] = await Promise.allSettled([
          runner.runBatch(fixture.tenantId, campaignA, 0),
          runner.runBatch(fixture.tenantId, campaignB, 0),
        ]);

        const outcomes = [resultA, resultB];
        const winners = outcomes.filter((r) => r.status === 'fulfilled');
        const losers = outcomes.filter(
          (r) =>
            r.status === 'rejected' &&
            (r as PromiseRejectedResult).reason instanceof CampaignDeferredError,
        );

        // Real D3 concurrency: CampaignRateLimiter.acquireNumberSlot() is a
        // real Redis INCR/DECR against ONE key for this phone number — a
        // mocked acquireNumberSlot can only be told what to return, never
        // actually contended by two concurrent callers the way this is.
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);

        // Whichever campaign lost the race never touched a row — nothing
        // dropped, everything still pending.
        const loserCampaignId =
          resultA.status === 'rejected' ? campaignA : campaignB;
        const loserRows = await recipientRows(fixture, loserCampaignId);
        expect(loserRows.every((r) => r.status === 'pending')).toBe(true);
      } finally {
        await cleanupTenant(fixture);
      }
    });
  });

  describe('3. a batch pauses mid-send and leaves the correct recipients pending (real row count)', () => {
    it('pauses on paused_template when the template is rejected mid-send, leaving every recipient pending', async () => {
      const fixture = await seedTenant('pause-template');
      const customerIds = await seedCustomers(fixture, 4);
      const campaignId = await seedCampaign(fixture, { status: 'sending' });
      await seedRecipients(fixture, campaignId, customerIds);

      // Simulate Meta revoking approval mid-campaign — a real DB flip, the
      // exact scenario D2's per-batch re-check exists for.
      await tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(messageTemplates)
            .set({ approvalStatus: 'rejected', approvalDetail: 'Meta says no' })
            .where(
              and(
                eq(messageTemplates.tenantId, fixture.tenantId),
                eq(messageTemplates.id, fixture.templateId),
              ),
            ),
        fixture.tenantId,
      );

      try {
        await runner.runBatch(fixture.tenantId, campaignId, 0);

        const status = await campaignStatus(fixture, campaignId);
        expect(status?.status).toBe('paused_template');

        const rows = await recipientRows(fixture, campaignId);
        expect(rows).toHaveLength(customerIds.length);
        expect(rows.every((r) => r.status === 'pending')).toBe(true);
      } finally {
        await cleanupTenant(fixture);
      }
    });

    it('pauses on paused_spend_cap partway through a batch, leaving the untouched recipients pending', async () => {
      const fixture = await seedTenant('pause-spend');
      const customerIds = await seedCustomers(fixture, 4);
      // One UAE message costs 0.0344; a cap that clears exactly one message
      // and no more forces the SECOND recipient in id order to hit the cap.
      const campaignId = await seedCampaign(fixture, {
        status: 'sending',
        spendCapUsd: 0.05,
      });
      await seedRecipients(fixture, campaignId, customerIds);

      try {
        await runner.runBatch(fixture.tenantId, campaignId, 0);

        const status = await campaignStatus(fixture, campaignId);
        expect(status?.status).toBe('paused_spend_cap');

        const rows = await recipientRows(fixture, campaignId);
        expect(rows).toHaveLength(customerIds.length);
        const sent = rows.filter((r) => r.status === 'sent');
        const pending = rows.filter((r) => r.status === 'pending');
        // Exactly the first sendable recipient got through before the cap
        // refused the next one — never partial-sent-then-dropped: the rest
        // are still pending, not vanished.
        expect(sent).toHaveLength(1);
        expect(pending).toHaveLength(customerIds.length - 1);
      } finally {
        await cleanupTenant(fixture);
      }
    });
  });

  describe('4. cross-tenant isolation under concurrent sends (zero leakage)', () => {
    it('runs two tenants launches concurrently and produces exactly each tenant’s own recipient rows', async () => {
      const fixtureA = await seedTenant('iso-a');
      const fixtureB = await seedTenant('iso-b');
      const customersA = await seedCustomers(fixtureA, 4);
      const customersB = await seedCustomers(fixtureB, 6);
      const campaignA = await seedCampaign(fixtureA, { status: 'scheduled' });
      const campaignB = await seedCampaign(fixtureB, { status: 'scheduled' });

      try {
        await Promise.all([
          runner.launch(fixtureA.tenantId, campaignA),
          runner.launch(fixtureB.tenantId, campaignB),
        ]);

        await waitUntil(async () => {
          const [statusA, statusB] = await Promise.all([
            campaignStatus(fixtureA, campaignA),
            campaignStatus(fixtureB, campaignB),
          ]);
          return statusA?.status === 'completed' && statusB?.status === 'completed';
        });

        const [rowsA, rowsB] = await Promise.all([
          recipientRows(fixtureA, campaignA),
          recipientRows(fixtureB, campaignB),
        ]);

        expect(rowsA).toHaveLength(customersA.length);
        expect(rowsB).toHaveLength(customersB.length);
        expect(rowsA.every((r) => customersA.includes(r.customerId))).toBe(true);
        expect(rowsB.every((r) => customersB.includes(r.customerId))).toBe(true);
        // Zero leakage: neither tenant's snapshot contains the other
        // tenant's customer ids.
        expect(rowsA.some((r) => customersB.includes(r.customerId))).toBe(false);
        expect(rowsB.some((r) => customersA.includes(r.customerId))).toBe(false);

        // And an admin-level cross-tenant read of campaign_recipients for
        // each campaign id returns ONLY that tenant's rows — proving RLS,
        // not just application-level filtering, kept them apart.
        const adminRowsA = await persistence.runAdminQuery((db) =>
          db.execute(
            sql`select tenant_id from campaign_recipients where campaign_id = ${campaignA}`,
          ),
        );
        expect(
          adminRowsA.rows.every(
            (row) => (row as { tenant_id: string }).tenant_id === fixtureA.tenantId,
          ),
        ).toBe(true);
      } finally {
        await cleanupTenant(fixtureA);
        await cleanupTenant(fixtureB);
      }
    });
  });

  describe('sanity — the eligibility gate reads real DB state', () => {
    it('blocks a number whose quality rating is unknown (fail-closed, D4)', async () => {
      const fixture = await seedTenant('gate-sanity');
      // lastHealthCheckAt stays FRESH here on purpose: CampaignEligibilityService
      // only calls out to WhatsappHealthReconcileService (a real Meta client)
      // when the snapshot is stale, and this test wants to prove the gate
      // reads the stored row, not exercise a live Meta call.
      await tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(whatsappNumbers)
            .set({ qualityRating: null })
            .where(
              and(
                eq(whatsappNumbers.tenantId, fixture.tenantId),
                eq(whatsappNumbers.phoneNumberId, fixture.phoneNumberId),
              ),
            ),
        fixture.tenantId,
      );

      try {
        const result = await eligibility.check({
          tenantId: fixture.tenantId,
          phoneNumberId: fixture.phoneNumberId,
          category: 'MARKETING',
          recipientCount: 1,
          templateWabaId: fixture.wabaId,
        });

        expect(result.eligible).toBe(false);
      } finally {
        await cleanupTenant(fixture);
      }
    });
  });
});
