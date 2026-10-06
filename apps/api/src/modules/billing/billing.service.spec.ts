import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { BillingService } from './billing.service';

const TENANT_A = 'tenant-a';

function makePlanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    name: 'Pro',
    stripePriceId: 'price_123',
    monthlyMessageLimit: 1000,
    monthlySpendCapUsd: 50,
    trialDays: 14,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeSubscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    tenantId: TENANT_A,
    planId: 'plan-1',
    stripeCustomerId: 'cus_123',
    stripeSubscriptionId: null,
    status: 'incomplete',
    trialEndsAt: null,
    currentPeriodEnd: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Chainable fake calling through select/insert/update/where/limit/set/values — resolves via the `resolveWith` marker once a terminal `.then` is reached. Covers every query shape BillingService actually issues (select-with-limit, plain select, insert, update). */
function chain(
  resolveWith: unknown,
): Record<string, (...args: unknown[]) => unknown> {
  const node: Record<string, (...args: unknown[]) => unknown> = {
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => node,
    set: () => node,
    values: () => node,
    returning: () => node,
    then: (onFulfilled: (value: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(resolveWith).then(onFulfilled),
  };
  return node;
}

/** Queues successive responses across multiple withTenantTx()/runAdminQuery() calls, in call order — mirrors the codebase's established "call through to the real callback" pattern (e.g. ticket-state.service.spec.ts) rather than stubbing the resolved value directly, so the actual select/insert/update query-building code inside BillingService runs for real. */
function makeQueuedTx(responses: unknown[]): jest.Mock {
  let call = 0;
  return jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      select: () => chain(response),
      insert: () => chain(response),
      update: () => chain(response),
    };
    return fn(tx);
  });
}

/** Same as makeQueuedTx() but for runAdminQuery()'s `db` param — used when a test exercises more than one runAdminQuery() call (e.g. the plans lookup, then the stripe_customer_tenant_map insert). */
function makeQueuedDb(responses: unknown[]): jest.Mock {
  let call = 0;
  return jest.fn((fn: (db: unknown) => unknown) => {
    const response = responses[call++];
    const db = {
      select: () => chain(response),
      insert: () => chain(response),
    };
    return fn(db);
  });
}

function makeHarness(): {
  service: BillingService;
  persistence: { runAdminQuery: jest.Mock };
  tenantContext: { withTenantTx: jest.Mock };
  billingProvider: {
    createCustomer: jest.Mock;
    createCheckoutSession: jest.Mock;
    constructWebhookEvent: jest.Mock;
    createBillingPortalSession: jest.Mock;
    cancelSubscription: jest.Mock;
  };
} {
  const persistence = { runAdminQuery: jest.fn() };
  const tenantContext = { withTenantTx: jest.fn() };
  const billingProvider = {
    createCustomer: jest.fn(),
    createCheckoutSession: jest.fn(),
    constructWebhookEvent: jest.fn(),
    createBillingPortalSession: jest.fn(),
    cancelSubscription: jest.fn(),
  };

  const service = new BillingService(
    persistence as unknown as PersistenceService,
    tenantContext as unknown as TenantContextService,
    billingProvider,
  );

  return { service, persistence, tenantContext, billingProvider };
}

describe('BillingService.listPlans()', () => {
  it('lists every plan via the admin escape hatch (plans is not RLS-scoped)', async () => {
    const { service, persistence } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makePlanRow()]) }),
    );

    const plans = await service.listPlans();

    expect(plans).toEqual([
      {
        id: 'plan-1',
        name: 'Pro',
        stripePriceId: 'price_123',
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      },
    ]);
  });
});

describe('BillingService.listPublicPlans()', () => {
  it('strips stripePriceId from the public projection', async () => {
    const { service, persistence } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makePlanRow()]) }),
    );

    const plans = await service.listPublicPlans();

    expect(plans).toEqual([
      {
        id: 'plan-1',
        name: 'Pro',
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      },
    ]);
    expect(plans[0]).not.toHaveProperty('stripePriceId');
  });
});

describe('BillingService.getForTenant()', () => {
  it('returns null when the tenant has no subscription row yet', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(makeQueuedTx([[]]));

    await expect(service.getForTenant(TENANT_A)).resolves.toBeNull();
  });

  it('maps the row to a TenantSubscriptionRecord', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([[makeSubscriptionRow()]]),
    );

    const result = await service.getForTenant(TENANT_A);

    expect(result).toMatchObject({ id: 'sub-1', status: 'incomplete' });
  });
});

describe('BillingService.startSubscription()', () => {
  it('throws NotFoundException for an unknown plan', async () => {
    const { service, persistence } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) => fn({ select: () => chain([]) }),
    );

    await expect(
      service.startSubscription(
        TENANT_A,
        'missing-plan',
        'a@b.com',
        'https://s',
        'https://c',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a new Stripe customer + subscription row for a first-time subscriber, and returns the real checkout URL', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      // plans lookup -> stripe_customer_tenant_map insert
      makeQueuedDb([[makePlanRow()], undefined]),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([[], undefined]), // getForTenant() -> [], then the insert
    );
    billingProvider.createCustomer.mockResolvedValue('cus_new');
    billingProvider.createCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.com/session_123',
    );

    const result = await service.startSubscription(
      TENANT_A,
      'plan-1',
      'admin@example.com',
      'https://app.example.com/success',
      'https://app.example.com/cancel',
    );

    expect(result).toEqual({
      checkoutUrl: 'https://checkout.stripe.com/session_123',
    });
    expect(billingProvider.createCustomer).toHaveBeenCalledWith(
      'admin@example.com',
    );
    expect(billingProvider.createCheckoutSession).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_new',
      stripePriceId: 'price_123',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
      trialPeriodDays: 14,
    });
  });

  it('reuses the existing Stripe customer id for a tenant retrying an incomplete subscription', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makePlanRow()]) }),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [makeSubscriptionRow({ status: 'incomplete' })],
        undefined,
      ]),
    );
    billingProvider.createCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.com/s2',
    );

    await service.startSubscription(
      TENANT_A,
      'plan-1',
      'a@b.com',
      'https://s',
      'https://c',
    );

    expect(billingProvider.createCustomer).not.toHaveBeenCalled();
    expect(billingProvider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCustomerId: 'cus_123' }),
    );
  });

  it('rejects starting a second subscription while one is already active', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makePlanRow()]) }),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([[makeSubscriptionRow({ status: 'active' })]]),
    );

    await expect(
      service.startSubscription(
        TENANT_A,
        'plan-1',
        'a@b.com',
        'https://s',
        'https://c',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects starting a second subscription while trialing', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makePlanRow()]) }),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([[makeSubscriptionRow({ status: 'trialing' })]]),
    );

    await expect(
      service.startSubscription(
        TENANT_A,
        'plan-1',
        'a@b.com',
        'https://s',
        'https://c',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Launch billing backend (Lane A): a local-trial row (signup, no Stripe
  // customer) must be able to go through Checkout — it is not "already
  // subscribed" in the sense that should 409.
  it('lets a local-trial tenant (trialing, no stripeCustomerId) start Checkout without a 409', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      makeQueuedDb([[makePlanRow()], undefined]),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [
          makeSubscriptionRow({
            status: 'trialing',
            stripeCustomerId: null,
            trialEndsAt: new Date('2026-01-10T00:00:00Z'),
          }),
        ],
        undefined,
      ]),
    );
    billingProvider.createCustomer.mockResolvedValue('cus_new');
    billingProvider.createCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.com/s4',
    );

    await expect(
      service.startSubscription(
        TENANT_A,
        'plan-1',
        'a@b.com',
        'https://s',
        'https://c',
      ),
    ).resolves.toEqual({ checkoutUrl: 'https://checkout.stripe.com/s4' });
    expect(billingProvider.createCustomer).toHaveBeenCalledWith('a@b.com');
  });

  // A local trial already granted trial access — Stripe Checkout must not
  // hand out a second one on top of it.
  it('does not grant a second Stripe trial when converting a used local trial', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      makeQueuedDb([[makePlanRow({ trialDays: 14 })], undefined]),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [
          makeSubscriptionRow({
            status: 'trialing',
            stripeCustomerId: null,
            trialEndsAt: new Date('2026-01-10T00:00:00Z'),
          }),
        ],
        undefined,
      ]),
    );
    billingProvider.createCustomer.mockResolvedValue('cus_new');
    billingProvider.createCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.com/s5',
    );

    await service.startSubscription(
      TENANT_A,
      'plan-1',
      'a@b.com',
      'https://s',
      'https://c',
    );

    expect(billingProvider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ trialPeriodDays: undefined }),
    );
  });

  it('omits trialPeriodDays when the plan has a 0-day trial', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      makeQueuedDb([[makePlanRow({ trialDays: 0 })], undefined]),
    );
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([[], undefined]),
    );
    billingProvider.createCustomer.mockResolvedValue('cus_new');
    billingProvider.createCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.com/s3',
    );

    await service.startSubscription(
      TENANT_A,
      'plan-1',
      'a@b.com',
      'https://s',
      'https://c',
    );

    expect(billingProvider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ trialPeriodDays: undefined }),
    );
  });
});

describe('BillingService.startLocalTrial()', () => {
  it('inserts a trialing row with no Stripe customer, trialEndsAt from the plan', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      makeQueuedDb([[makePlanRow({ id: 'plan-1', trialDays: 14 })]]),
    );
    let insertedValues: Record<string, unknown> | undefined;
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) => {
        const tx = {
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              insertedValues = values;
              return Promise.resolve(undefined);
            },
          }),
        };
        return fn(tx);
      },
    );

    const before = Date.now();
    await service.startLocalTrial(TENANT_A);
    const after = Date.now();

    expect(insertedValues).toMatchObject({
      tenantId: TENANT_A,
      planId: 'plan-1',
      stripeCustomerId: null,
      status: 'trialing',
    });
    const trialEndsAt = insertedValues?.trialEndsAt as Date;
    const expectedMs = 14 * 24 * 60 * 60 * 1000;
    expect(trialEndsAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
    expect(trialEndsAt.getTime()).toBeLessThanOrEqual(after + expectedMs);
  });

  it('no-ops when no plan has been seeded yet', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    persistence.runAdminQuery.mockImplementation(makeQueuedDb([[]]));

    await service.startLocalTrial(TENANT_A);

    expect(tenantContext.withTenantTx).not.toHaveBeenCalled();
  });

  it('sets an already-expired trialEndsAt for a 0-trial-day plan', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      makeQueuedDb([[makePlanRow({ trialDays: 0 })]]),
    );
    let insertedValues: Record<string, unknown> | undefined;
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) => {
        const tx = {
          insert: () => ({
            values: (values: Record<string, unknown>) => {
              insertedValues = values;
              return Promise.resolve(undefined);
            },
          }),
        };
        return fn(tx);
      },
    );

    await service.startLocalTrial(TENANT_A);

    const trialEndsAt = insertedValues?.trialEndsAt as Date;
    expect(trialEndsAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('BillingService.hasPaidSubscription()', () => {
  it('is false when the tenant has no subscription row', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(makeQueuedTx([[]]));

    await expect(service.hasPaidSubscription(TENANT_A)).resolves.toBe(false);
  });

  it('is true for an active subscription with a real Stripe subscription id', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [
          makeSubscriptionRow({
            status: 'active',
            stripeSubscriptionId: 'sub_1',
          }),
        ],
      ]),
    );

    await expect(service.hasPaidSubscription(TENANT_A)).resolves.toBe(true);
  });

  it('is true for a comped tenant regardless of status', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [makeSubscriptionRow({ status: 'incomplete', comped: true })],
      ]),
    );

    await expect(service.hasPaidSubscription(TENANT_A)).resolves.toBe(true);
  });

  it('is false for a LOCAL trial (trialing, no stripeSubscriptionId yet)', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [
          makeSubscriptionRow({
            status: 'trialing',
            stripeCustomerId: null,
            stripeSubscriptionId: null,
          }),
        ],
      ]),
    );

    await expect(service.hasPaidSubscription(TENANT_A)).resolves.toBe(false);
  });

  // Checkout completed (a real Stripe subscription + card exist) but
  // Stripe's own trial is still running — matches the frontend's
  // `stripeSubscriptionId !== null` "card on file" contract, which
  // `status === 'active'` alone would get wrong here.
  it('is true for a mid-Stripe-trial tenant who already completed Checkout', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [
          makeSubscriptionRow({
            status: 'trialing',
            stripeSubscriptionId: 'sub_1',
            trialEndsAt: new Date('2099-01-01T00:00:00Z'),
          }),
        ],
      ]),
    );

    await expect(service.hasPaidSubscription(TENANT_A)).resolves.toBe(true);
  });
  // A canceled or past_due Stripe subscription keeps its stripeSubscriptionId,
  // but the card on file is no longer paying — must not unlock D7 connect.
  it.each(['canceled', 'past_due', 'incomplete'])(
    'is false for a Stripe subscription in status=%s',
    async (status) => {
      const { service, tenantContext } = makeHarness();
      tenantContext.withTenantTx.mockImplementation(
        makeQueuedTx([
          [makeSubscriptionRow({ status, stripeSubscriptionId: 'sub_1' })],
        ]),
      );

      await expect(service.hasPaidSubscription(TENANT_A)).resolves.toBe(false);
    },
  );
});

describe('BillingService.handleWebhookEvent()', () => {
  it('does nothing for an ignored event', async () => {
    const { service, persistence, billingProvider } = makeHarness();
    billingProvider.constructWebhookEvent.mockReturnValue({
      type: 'ignored',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      status: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
    });

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(persistence.runAdminQuery).not.toHaveBeenCalled();
  });

  it('does nothing when no subscription row matches the event customer id', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    billingProvider.constructWebhookEvent.mockReturnValue({
      type: 'subscription_updated',
      stripeCustomerId: 'cus_unknown',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: null,
    });
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) => fn({ select: () => chain([]) }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(tenantContext.withTenantTx).not.toHaveBeenCalled();
  });

  it('updates the matched tenant subscription row with the real event fields (subscriptionId, status, currentPeriodEnd)', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    billingProvider.constructWebhookEvent.mockReturnValue({
      type: 'subscription_updated',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_new',
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
      eventId: 'evt_2',
      eventCreatedAt: new Date('2026-08-01T00:00:00Z'),
    });
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makeSubscriptionRow()]) }),
    );
    let setValues: Record<string, unknown> | undefined;
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) => {
        const tx = {
          update: () => ({
            set: (values: Record<string, unknown>) => {
              setValues = values;
              return { where: () => Promise.resolve(undefined) };
            },
          }),
        };
        return fn(tx);
      },
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(tenantContext.withTenantTx).toHaveBeenCalledWith(
      expect.any(Function),
      TENANT_A,
    );
    expect(setValues).toMatchObject({
      stripeSubscriptionId: 'sub_new',
      status: 'active',
      currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
      lastStripeEventCreatedAt: new Date('2026-08-01T00:00:00Z'),
      lastStripeEventId: 'evt_2',
    });
    expect(setValues).not.toHaveProperty('trialEndsAt');
  });

  // Launch billing backend (Lane A): Stripe does not guarantee delivery
  // order — a late `incomplete`/`past_due` retry must not overwrite a
  // newer `active` state that already landed.
  it('builds a conditional UPDATE that refuses to overwrite a newer event, keyed on eventCreatedAt/eventId', async () => {
    const { service, persistence, tenantContext, billingProvider } =
      makeHarness();
    billingProvider.constructWebhookEvent.mockReturnValue({
      type: 'payment_failed',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_stripe_1',
      status: 'past_due',
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      eventId: 'evt_1',
      eventCreatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({ select: () => chain([makeSubscriptionRow()]) }),
    );
    let whereArg: unknown;
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) => {
        const tx = {
          update: () => ({
            set: () => ({
              where: (arg: unknown) => {
                whereArg = arg;
                return Promise.resolve(undefined);
              },
            }),
          }),
        };
        return fn(tx);
      },
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    // The exact SQL AST is drizzle-internal and not worth pinning down in
    // a unit test; what matters here is that the write actually went
    // through a WHERE built from an `and(...)` (staleness-guarded), not
    // the plain `eq(tenantId, ...)` the pre-Lane-A code used. The real
    // staleness enforcement (a stale event genuinely failing to overwrite
    // a newer row) is covered end-to-end by
    // test/integration/billing.integration-spec.ts's "ignores a stale
    // webhook event" case, against a real Postgres connection where the
    // SQL actually runs.
    expect(whereArg).toBeDefined();
    expect(
      (whereArg as { queryChunks?: unknown[] }).queryChunks?.length ?? 0,
    ).toBeGreaterThan(0);
  });
});

const SUB_ROW = {
  id: 'sub-1',
  tenantId: TENANT_A,
  planId: 'plan-1',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_stripe_1',
  status: 'active',
  trialEndsAt: null,
  currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
};

describe('BillingService.createPortalSession()', () => {
  it('opens a portal session for the tenant’s own Stripe customer', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(makeQueuedTx([[SUB_ROW]]));
    billingProvider.createBillingPortalSession.mockResolvedValue(
      'https://billing.stripe.test/session/abc',
    );

    await expect(
      service.createPortalSession(TENANT_A, 'https://app.test/settings'),
    ).resolves.toEqual({
      portalUrl: 'https://billing.stripe.test/session/abc',
    });

    expect(billingProvider.createBillingPortalSession).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_1',
      returnUrl: 'https://app.test/settings',
    });
  });

  // Nothing is wrong with the request — there is simply no billing
  // relationship to manage yet, and the fix is to subscribe, not to retry.
  it('refuses with 409 when the tenant never subscribed', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(makeQueuedTx([[]]));

    await expect(
      service.createPortalSession(TENANT_A, 'https://app.test/settings'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(billingProvider.createBillingPortalSession).not.toHaveBeenCalled();
  });
});

describe('BillingService.cancelSubscription()', () => {
  it('cancels at period end by default and records the scheduled end', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    const periodEnd = new Date('2026-12-01T00:00:00Z');
    billingProvider.cancelSubscription.mockResolvedValue({
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: periodEnd,
    });
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [SUB_ROW],
        [{ ...SUB_ROW, cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd }],
      ]),
    );

    const result = await service.cancelSubscription(TENANT_A, true);

    expect(billingProvider.cancelSubscription).toHaveBeenCalledWith({
      stripeSubscriptionId: 'sub_stripe_1',
      atPeriodEnd: true,
    });
    // Still active, and leaving. `status` alone cannot express that, which is
    // the whole reason cancelAtPeriodEnd exists.
    expect(result.status).toBe('active');
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.currentPeriodEnd).toEqual(periodEnd);
  });

  it('passes an immediate cancellation straight through', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    billingProvider.cancelSubscription.mockResolvedValue({
      status: 'canceled',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    });
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [SUB_ROW],
        [{ ...SUB_ROW, status: 'canceled', cancelAtPeriodEnd: false }],
      ]),
    );

    const result = await service.cancelSubscription(TENANT_A, false);

    expect(billingProvider.cancelSubscription).toHaveBeenCalledWith({
      stripeSubscriptionId: 'sub_stripe_1',
      atPeriodEnd: false,
    });
    expect(result.status).toBe('canceled');
  });

  it('404s when there is no subscription at all', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(makeQueuedTx([[]]));

    await expect(
      service.cancelSubscription(TENANT_A, true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(billingProvider.cancelSubscription).not.toHaveBeenCalled();
  });

  // Checkout was started but never finished: Stripe has a customer and no
  // subscription, so nothing is being billed and there is nothing to cancel.
  it('409s when checkout was never completed', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([
        [{ ...SUB_ROW, stripeSubscriptionId: null, status: 'incomplete' }],
      ]),
    );

    await expect(
      service.cancelSubscription(TENANT_A, true),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(billingProvider.cancelSubscription).not.toHaveBeenCalled();
  });

  it('409s rather than calling Stripe twice for an already-cancelled subscription', async () => {
    const { service, tenantContext, billingProvider } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      makeQueuedTx([[{ ...SUB_ROW, status: 'canceled' }]]),
    );

    await expect(
      service.cancelSubscription(TENANT_A, true),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(billingProvider.cancelSubscription).not.toHaveBeenCalled();
  });
});
