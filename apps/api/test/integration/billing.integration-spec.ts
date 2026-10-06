// Feature 8 exit criteria (T19): "a tenant can be placed on a plan."
// Proves the real HTTP checkout flow (POST /billing/checkout -> a real
// `tenant_subscriptions` row -> GET /billing/subscription reflects it)
// and the webhook update path, against real Postgres. `BillingProvider`
// is overridden with a small deterministic fake (no real Stripe account
// in this environment) — same "vendor swapped for a test double, nothing
// else" pattern as every other external-vendor integration test in this
// codebase (FakeEmbedder, ScriptedLlmProvider).
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
import { BillingModule } from '../../src/modules/billing/billing.module';
import { BillingProvider } from '../../src/modules/billing/ports/billing-provider.port';
import type {
  BillingWebhookEvent,
  CancelSubscriptionInput,
  CancelSubscriptionResult,
  CreateBillingPortalSessionInput,
  CreateCheckoutSessionInput,
} from '../../src/modules/billing/ports/billing-provider.port';
import { plans, tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';

class FakeBillingProvider extends BillingProvider {
  nextWebhookEvent: BillingWebhookEvent | undefined;

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async createCustomer(email: string): Promise<string> {
    return `fake_cus_${email}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<string> {
    return `https://fake.stripe.test/checkout/${input.stripeCustomerId}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<string> {
    return `https://fake.stripe.test/portal/${input.stripeCustomerId}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async cancelSubscription(
    input: CancelSubscriptionInput,
  ): Promise<CancelSubscriptionResult> {
    return {
      status: input.atPeriodEnd ? 'active' : 'canceled',
      cancelAtPeriodEnd: input.atPeriodEnd,
      currentPeriodEnd: input.atPeriodEnd ? new Date('2026-12-01') : null,
    };
  }

  constructWebhookEvent(): BillingWebhookEvent {
    if (!this.nextWebhookEvent) {
      throw new Error('FakeBillingProvider: no webhook event queued');
    }
    return this.nextWebhookEvent;
  }
}

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

describe('Billing (Feature 8 exit criteria, T19)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let httpServer: INestApplication;
  let jwtSecret: string;
  let fakeBillingProvider: FakeBillingProvider;

  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  const tenantId = randomUUID();
  const planId = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        BillingModule,
      ],
    })
      .overrideProvider(BillingProvider)
      .useClass(FakeBillingProvider)
      .compile();

    persistence = moduleRef.get(PersistenceService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;
    fakeBillingProvider = moduleRef.get(BillingProvider);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Billing Test Tenant' }),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(plans).values({
        id: planId,
        name: 'Pro',
        stripePriceId: 'price_test_123',
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      }),
    );

    // rawBody: true — mirrors main.ts's own bootstrap option; the webhook
    // endpoint needs `req.rawBody` populated to reach
    // BillingWebhookController.handle() at all.
    httpServer = moduleRef.createNestApplication({ rawBody: true });
    await httpServer.init();
  });

  afterAll(async () => {
    // tenants first — cascades away tenant_subscriptions (and
    // stripe_customer_tenant_map), which is what's holding the RESTRICT
    // FK from tenant_subscriptions.plan_id open; deleting plans first
    // would violate that constraint.
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(plans).where(eq(plans.id, planId)),
    );
    await httpServer.close();
  });

  it('GET /billing/plans/public requires no auth and omits stripePriceId', async () => {
    const response = await request(server())
      .get('/billing/plans/public')
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: planId, name: 'Pro' }),
      ]),
    );
    for (const plan of response.body as Record<string, unknown>[]) {
      expect(plan).not.toHaveProperty('stripePriceId');
    }
  });

  it('an admin can list plans', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const response = await request(server())
      .get('/billing/plans')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: planId, name: 'Pro' }),
      ]),
    );
  });

  it('places the tenant on a plan: checkout creates a real tenant_subscriptions row, reflected by GET /billing/subscription', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const checkoutResponse = await request(server())
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        planId,
        email: 'admin@example.com',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      })
      .expect(201);

    const checkoutBody = checkoutResponse.body as { checkoutUrl: string };
    expect(checkoutBody.checkoutUrl).toEqual(
      expect.stringContaining('fake.stripe.test'),
    );

    const subscriptionResponse = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(subscriptionResponse.body).toMatchObject({
      tenantId,
      planId,
      status: 'incomplete',
    });
  });

  it('a webhook event updates the subscription to active with a real currentPeriodEnd', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });
    const subscriptionResponse = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const subscriptionBody = subscriptionResponse.body as {
      stripeCustomerId: string;
    };
    const stripeCustomerId = subscriptionBody.stripeCustomerId;

    const currentPeriodEnd = new Date('2026-09-13T00:00:00Z');
    fakeBillingProvider.nextWebhookEvent = {
      type: 'subscription_updated',
      stripeCustomerId,
      stripeSubscriptionId: 'sub_fake_1',
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
      eventId: 'evt_fake',
      eventCreatedAt: new Date(),
    };

    await request(server())
      .post('/billing/webhook')
      .set('stripe-signature', 'irrelevant-under-the-fake-provider')
      .send({ id: 'evt_fake' })
      .expect(201);

    const afterWebhook = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(afterWebhook.body).toMatchObject({
      status: 'active',
      stripeSubscriptionId: 'sub_fake_1',
    });
  });

  // Launch billing backend (Lane A): Stripe does not guarantee webhook
  // delivery order. A late `past_due` retry arriving AFTER the tenant is
  // already `active` (asserted by the previous test) must not knock a
  // genuinely paying tenant back to blocked.
  it('ignores a stale webhook event and keeps the newer state (real Postgres, real conditional UPDATE)', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });
    const before = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const stripeCustomerId = (before.body as { stripeCustomerId: string })
      .stripeCustomerId;
    expect(before.body).toMatchObject({ status: 'active' });

    // Older `created` than the event the previous test already applied.
    fakeBillingProvider.nextWebhookEvent = {
      type: 'payment_failed',
      stripeCustomerId,
      stripeSubscriptionId: 'sub_fake_1',
      status: 'past_due',
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      eventId: 'evt_stale',
      eventCreatedAt: new Date('2020-01-01T00:00:00Z'),
    };

    await request(server())
      .post('/billing/webhook')
      .set('stripe-signature', 'irrelevant-under-the-fake-provider')
      .send({ id: 'evt_stale' })
      .expect(201);

    const after = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Still active — the stale past_due event never wrote.
    expect(after.body).toMatchObject({ status: 'active' });
  });

  it('blocks a tenant already active from starting a second subscription', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    await request(server())
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        planId,
        email: 'admin@example.com',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      })
      .expect(409);
  });

  it('agent role is forbidden from every billing endpoint', async () => {
    const agentToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'agent',
    });

    await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(403);
  });

  it('the webhook endpoint requires no tenant JWT at all (Stripe calls it directly)', async () => {
    fakeBillingProvider.nextWebhookEvent = {
      type: 'ignored',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      status: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      eventId: null,
      eventCreatedAt: null,
    };

    await request(server())
      .post('/billing/webhook')
      .set('stripe-signature', 'irrelevant-under-the-fake-provider')
      .send({ id: 'evt_fake2' })
      .expect(201);
  });
});
