// BillingModule (Feature 8, T19): bound when BILLING_PROVIDER is 'none'
// (the default — no Stripe account configured in this environment), same
// "real no-op adapter, never a placeholder credential" pattern as
// NoopRerankerAdapter/NoopProvisioningAdapter. `createCustomer()`/
// `createCheckoutSession()` fabricate ids/URLs and log clearly what they
// would have done. `constructWebhookEvent()` is different in kind from
// the other two: there's no real webhook secret to verify against under
// 'none', so a request hitting the webhook endpoint at all is either a
// misconfiguration or a forged request — this always returns an
// `'ignored'` event rather than attempting (and failing) real signature
// verification, and logs loudly since it should never happen in a
// correctly configured deployment.
import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppLoggerService } from '../../core';
import {
  BillingProvider,
  type BillingWebhookEvent,
  type CancelSubscriptionResult,
  type CreateBillingPortalSessionInput,
  type CreateCheckoutSessionInput,
} from './billing-provider.port';

@Injectable()
export class NoopBillingProvider extends BillingProvider {
  constructor(private readonly logger: AppLoggerService) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async createCustomer(email: string): Promise<string> {
    const fakeCustomerId = `noop_cus_${randomUUID()}`;
    this.logger.warn(
      `NoopBillingProvider: no Stripe account configured (BILLING_PROVIDER=none) — would have created a Stripe customer for ${email}. fakeCustomerId=${fakeCustomerId} is not a real Stripe customer.`,
      'NoopBillingProvider',
    );
    return fakeCustomerId;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<string> {
    this.logger.warn(
      `NoopBillingProvider: no Stripe account configured (BILLING_PROVIDER=none) — would have created a checkout session for customer ${input.stripeCustomerId}, price ${input.stripePriceId}. No real checkout URL exists.`,
      'NoopBillingProvider',
    );
    return input.cancelUrl;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<string> {
    this.logger.warn(
      `NoopBillingProvider: no Stripe account configured (BILLING_PROVIDER=none) — would have opened a billing portal session for customer ${input.stripeCustomerId}. No real portal URL exists.`,
      'NoopBillingProvider',
    );
    // The return URL, not a fabricated portal link: sending an admin to a dead
    // URL would look like a broken product, whereas landing them back where
    // they started matches what actually happened, which is nothing.
    return input.returnUrl;
  }

  /**
   * Throws rather than reporting a cancellation that never happened.
   *
   * The other methods here can degrade to a no-op honestly, because nothing
   * downstream depends on their result being true. This one is different: a
   * fabricated success would write `cancelAtPeriodEnd` to the subscription
   * row, so the product would tell a tenant they had cancelled while Stripe
   * kept billing them. Failing closed is the only safe answer.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract a real adapter needs.
  async cancelSubscription(): Promise<CancelSubscriptionResult> {
    this.logger.error(
      'NoopBillingProvider: refusing to report a cancellation with no Stripe account configured (BILLING_PROVIDER=none) — a tenant must never be told they cancelled when nothing was cancelled.',
      'NoopBillingProvider',
    );
    throw new ServiceUnavailableException(
      'Billing is not configured on this deployment, so a subscription cannot be cancelled here. Contact support.',
    );
  }

  constructWebhookEvent(): BillingWebhookEvent {
    this.logger.warn(
      'NoopBillingProvider: received a webhook request with no Stripe account configured (BILLING_PROVIDER=none) — ' +
        'this should never happen in a correctly configured deployment. Ignoring.',
      'NoopBillingProvider',
    );
    return {
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
  }
}
