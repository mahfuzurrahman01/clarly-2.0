// Feature 8 (T19): the Stripe *seam*, which billing.integration-spec.ts
// deliberately does not cover.
//
// That suite swaps `BillingProvider` for a deterministic fake, so it proves
// this app's own logic — plan lookup, RLS-scoped writes, the
// stripe_customer_tenant_map resolution, role gates — while the Stripe SDK
// itself never runs. Everything on the other side of the port was therefore
// unproven: whether the SDK is wired up correctly, whether a real API
// response parses into what `startSubscription()` expects, and whether
// signature verification actually passes on a genuinely signed request.
// That is where a payment integration usually breaks, and it is exactly the
// part a mocked SDK cannot tell you about.
//
// So this suite runs the REAL `StripeBillingProvider` against two real
// things:
//
//   - `stripe-mock` — Stripe's own offline API double, serving responses
//     generated from their published OpenAPI spec. Real HTTP, real SDK
//     request signing and response parsing, no account and no network.
//     Pointed at via STRIPE_API_BASE_URL (see stripe-billing.provider.ts's
//     localApiOptions(), which uses the SDK's documented host/port/protocol
//     options).
//   - real `stripe.webhooks.constructEvent()`, given a header built by the
//     SDK's own `generateTestHeaderString()` — the method Stripe documents
//     for precisely this. The signature is genuine; only the sender is not.
//
// What it still cannot prove: that Stripe's live API behaves like its spec.
// Only a test-mode key against api.stripe.com closes that last gap.
//
// Requires real Postgres and a local stripe-mock:
//   brew install stripe-mock && stripe-mock -http-port 12111
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import Stripe from 'stripe';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { BillingModule } from '../../src/modules/billing/billing.module';
import { BillingProvider } from '../../src/modules/billing/ports/billing-provider.port';
import { StripeBillingProvider } from '../../src/modules/billing/ports/stripe-billing.provider';
import { plans, tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';

const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://127.0.0.1:12111';
const WEBHOOK_SECRET = 'whsec_integration_test_secret';

function signToken(
  secret: string,
  claims: { sub: string; tenantId: string; appRole: 'admin' | 'agent' },
): string {
  return jwt.sign(
    {
      sub: claims.sub,
      role: 'authenticated',
      app_metadata: { tenant_id: claims.tenantId, app_role: claims.appRole },
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

/**
 * A Stripe event body of the shape the real API sends, signed for real.
 *
 * Built by hand rather than replayed from a fixture because the values that
 * matter here — the customer id minted by stripe-mock earlier in the run,
 * the period end this app is expected to persist — have to be ours.
 */
function signedEvent(
  stripe: Stripe,
  event: Record<string, unknown>,
): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  return {
    payload,
    signature: stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    }),
  };
}

describe('Billing — real Stripe SDK against stripe-mock (T19 seam)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let httpServer: INestApplication;
  let jwtSecret: string;
  let stripe: Stripe;
  let stripeCustomerId: string;

  const tenantId = randomUUID();
  const planId = randomUUID();
  const envBackup = { ...process.env };

  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  beforeAll(async () => {
    // Set before the module compiles: CoreModule validates process.env once
    // at construction, so BILLING_PROVIDER has to be 'stripe' by then for
    // BillingModule's factory to bind the real provider.
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_integration';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_API_BASE_URL = STRIPE_MOCK_URL;

    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        BillingModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;
    stripe = new Stripe('sk_test_integration');

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Stripe Seam Tenant' }),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(plans).values({
        id: planId,
        name: 'Seam Pro',
        stripePriceId: 'price_seam_123',
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      }),
    );

    httpServer = moduleRef.createNestApplication({ rawBody: true });
    await httpServer.init();
  });

  afterAll(async () => {
    // Scoped to this suite's own rows. The sibling billing suite clears the
    // whole table; that is safe there only because it owns its database.
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(plans).where(eq(plans.id, planId)),
    );
    await httpServer.close();
    process.env = envBackup;
  });

  it('binds the real StripeBillingProvider when BILLING_PROVIDER=stripe', () => {
    expect(moduleRef.get(BillingProvider)).toBeInstanceOf(
      StripeBillingProvider,
    );
  });

  it('checkout runs a real SDK round trip and persists what Stripe actually returned', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const response = await request(server())
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        planId,
        email: 'admin@example.com',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      })
      .expect(201);

    // A URL Stripe minted, not one this app echoed back — the exact
    // failure the no-op adapter would have hidden.
    const body = response.body as { checkoutUrl: string };
    expect(body.checkoutUrl).toEqual(
      expect.stringContaining('checkout.stripe.com'),
    );

    const subscription = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const persisted = subscription.body as {
      stripeCustomerId: string;
      status: string;
      planId: string;
    };
    // `cus_` is the SDK parsing a real customer object out of a real HTTP
    // response, not a placeholder this app invented.
    expect(persisted.stripeCustomerId).toMatch(/^cus_/);
    expect(persisted).toMatchObject({ planId, status: 'incomplete' });

    stripeCustomerId = persisted.stripeCustomerId;
  });

  it('a genuinely signed webhook passes verification and moves the subscription to active', async () => {
    const currentPeriodEnd = Math.floor(
      new Date('2026-09-21T00:00:00Z').getTime() / 1000,
    );
    const { payload, signature } = signedEvent(stripe, {
      id: 'evt_seam_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_seam_1',
          object: 'subscription',
          customer: stripeCustomerId,
          status: 'active',
          cancel_at_period_end: false,
          trial_end: null,
          items: {
            object: 'list',
            data: [{ current_period_end: currentPeriodEnd }],
          },
        },
      },
    });

    await request(server())
      .post('/billing/webhook')
      .set('stripe-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(201);

    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });
    const after = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(after.body).toMatchObject({
      status: 'active',
      stripeSubscriptionId: 'sub_seam_1',
    });
  });

  it('opens a real billing portal session rather than echoing the return URL back', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });
    const returnUrl = 'https://app.example.com/settings/billing';

    const response = await request(server())
      .post('/billing/portal')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ returnUrl })
      .expect(201);

    const body = response.body as { portalUrl: string };
    // The no-op adapter answers with the caller's own returnUrl, which looks
    // exactly like success. A real session is a URL Stripe minted, and it is
    // never the one we sent.
    expect(body.portalUrl).not.toEqual(returnUrl);
    expect(body.portalUrl).toMatch(/^https:\/\//);
  });

  // Ending a subscription later is an UPDATE that leaves it running; ending
  // it now is a different call entirely. The provider picks between them, so
  // the round trip is what proves the right one was made.
  it('cancels at period end through a real subscription update', async () => {
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });

    const response = await request(server())
      .post('/billing/cancel')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ atPeriodEnd: true })
      .expect(201);

    expect(response.body).toMatchObject({ cancelAtPeriodEnd: true });

    const after = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Still active, because that is what cancelling at period end means: the
    // tenant keeps the time they already paid for.
    expect(after.body).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
  });

  // The whole point of the secret. A forged event that flipped a
  // subscription to active would be free service; one that flipped it to
  // canceled would cut off a paying customer.
  it('refuses an event whose signature does not match the secret', async () => {
    const { payload } = signedEvent(stripe, {
      id: 'evt_forged',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_seam_1', customer: stripeCustomerId } },
    });

    const forged = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_not_the_real_secret',
    });

    await request(server())
      .post('/billing/webhook')
      .set('stripe-signature', forged)
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(401);

    // Still active: the forged cancellation changed nothing.
    const adminToken = signToken(jwtSecret, {
      sub: randomUUID(),
      tenantId,
      appRole: 'admin',
    });
    const after = await request(server())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body).toMatchObject({ status: 'active' });
  });
});
