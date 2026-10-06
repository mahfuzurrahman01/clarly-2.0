import { UnauthorizedException } from '@nestjs/common';
import type { AppConfigService } from '../../core';
import { StripeBillingProvider } from './stripe-billing.provider';

const customersCreate = jest.fn();
const checkoutSessionsCreate = jest.fn();
const webhooksConstructEvent = jest.fn();

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    customers: { create: customersCreate },
    checkout: { sessions: { create: checkoutSessionsCreate } },
    webhooks: { constructEvent: webhooksConstructEvent },
  })),
}));

function makeConfig(): AppConfigService {
  return {
    stripeSecretKey: 'sk_test_123',
    stripeWebhookSecret: 'whsec_123',
  } as AppConfigService;
}

describe('StripeBillingProvider', () => {
  beforeEach(() => {
    customersCreate.mockReset();
    checkoutSessionsCreate.mockReset();
    webhooksConstructEvent.mockReset();
  });

  it('does not construct the Stripe client eagerly in the constructor', () => {
    expect(() => new StripeBillingProvider(makeConfig())).not.toThrow();
  });

  it('createCustomer() returns the real Stripe customer id', async () => {
    customersCreate.mockResolvedValue({ id: 'cus_real' });
    const provider = new StripeBillingProvider(makeConfig());

    await expect(provider.createCustomer('a@b.com')).resolves.toBe('cus_real');
    expect(customersCreate).toHaveBeenCalledWith({ email: 'a@b.com' });
  });

  it('createCheckoutSession() returns the real checkout URL', async () => {
    checkoutSessionsCreate.mockResolvedValue({
      url: 'https://checkout.stripe.com/real',
    });
    const provider = new StripeBillingProvider(makeConfig());

    const url = await provider.createCheckoutSession({
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_1',
      successUrl: 'https://s',
      cancelUrl: 'https://c',
      trialPeriodDays: 14,
    });

    expect(url).toBe('https://checkout.stripe.com/real');
    expect(checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_1',
        subscription_data: { trial_period_days: 14 },
      }),
    );
  });

  it('createCheckoutSession() throws when Stripe returns no url', async () => {
    checkoutSessionsCreate.mockResolvedValue({ url: null });
    const provider = new StripeBillingProvider(makeConfig());

    await expect(
      provider.createCheckoutSession({
        stripeCustomerId: 'cus_1',
        stripePriceId: 'price_1',
        successUrl: 'https://s',
        cancelUrl: 'https://c',
      }),
    ).rejects.toThrow('no url');
  });

  it('constructWebhookEvent() maps checkout.session.completed', () => {
    webhooksConstructEvent.mockReturnValue({
      id: 'evt_1',
      created: 1893456000,
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event).toEqual({
      type: 'checkout_completed',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      // A checkout says nothing about a scheduled cancellation.
      cancelAtPeriodEnd: null,
      status: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      eventId: 'evt_1',
      eventCreatedAt: new Date(1893456000 * 1000),
    });
  });

  it('constructWebhookEvent() carries the Stripe event id/created through for ordering (Lane A staleness guard)', () => {
    webhooksConstructEvent.mockReturnValue({
      id: 'evt_42',
      created: 1893456000,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          trial_end: null,
          items: { data: [{ current_period_end: null }] },
        },
      },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event.eventId).toBe('evt_42');
    expect(event.eventCreatedAt).toEqual(new Date(1893456000 * 1000));
  });

  it('constructWebhookEvent() leaves eventId/eventCreatedAt null for an ignored event', () => {
    webhooksConstructEvent.mockReturnValue({
      id: 'evt_ignored',
      created: 1893456000,
      type: 'customer.updated',
      data: { object: {} },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event.eventId).toBeNull();
    expect(event.eventCreatedAt).toBeNull();
  });

  it('constructWebhookEvent() maps customer.subscription.updated with status/trial/period', () => {
    webhooksConstructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'trialing',
          trial_end: 1893456000,
          items: { data: [{ current_period_end: 1893456000 }] },
        },
      },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event.type).toBe('subscription_updated');
    expect(event.status).toBe('trialing');
    expect(event.trialEndsAt).toEqual(new Date(1893456000 * 1000));
  });

  it.each([
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['unpaid', 'past_due'],
    ['canceled', 'canceled'],
    ['incomplete_expired', 'canceled'],
    ['paused', 'canceled'],
    ['incomplete', 'incomplete'],
    ['some_future_stripe_status', 'incomplete'],
  ])(
    'constructWebhookEvent() maps Stripe status "%s" to this app\'s "%s"',
    (stripeStatus, expectedStatus) => {
      webhooksConstructEvent.mockReturnValue({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: stripeStatus,
            trial_end: null,
            items: { data: [{ current_period_end: null }] },
          },
        },
      });
      const provider = new StripeBillingProvider(makeConfig());

      const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

      expect(event.status).toBe(expectedStatus);
    },
  );

  it('constructWebhookEvent() maps customer.subscription.deleted to status: canceled', () => {
    webhooksConstructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled' } },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event).toMatchObject({
      type: 'subscription_deleted',
      status: 'canceled',
    });
  });

  it('constructWebhookEvent() maps invoice.payment_failed to status: past_due', () => {
    webhooksConstructEvent.mockReturnValue({
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event).toMatchObject({ type: 'payment_failed', status: 'past_due' });
  });

  it('constructWebhookEvent() maps unrecognized event types to "ignored"', () => {
    webhooksConstructEvent.mockReturnValue({
      type: 'customer.updated',
      data: { object: {} },
    });
    const provider = new StripeBillingProvider(makeConfig());

    const event = provider.constructWebhookEvent(Buffer.from('{}'), 'sig');

    expect(event.type).toBe('ignored');
  });

  it('constructWebhookEvent() throws UnauthorizedException (not the raw Stripe error) on a bad signature', () => {
    webhooksConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const provider = new StripeBillingProvider(makeConfig());

    expect(() =>
      provider.constructWebhookEvent(Buffer.from('{}'), 'bad-sig'),
    ).toThrow(UnauthorizedException);
  });
});
