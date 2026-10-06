// BillingModule (Feature 8, T19): the real Stripe binding. Like every
// other "always constructed regardless of which adapter the module's
// factory actually selects" adapter in this codebase
// (SupabaseAdminProvisioningAdapter being the direct precedent), the
// Stripe client is built lazily on first real use, not in the
// constructor — `stripeSecretKey` is legitimately an empty string under
// the default 'none' provider, and constructing a Stripe client with an
// empty key would throw immediately.
import { Injectable, UnauthorizedException } from '@nestjs/common';
import Stripe from 'stripe';
import { AppConfigService } from '../../core';
import type { SubscriptionStatus } from '../../persistence/drizzle/tenant-subscriptions.table';
import {
  type CancelSubscriptionInput,
  type CancelSubscriptionResult,
  type CreateBillingPortalSessionInput,
  BillingProvider,
  type BillingWebhookEvent,
  type BillingWebhookEventType,
  type CreateCheckoutSessionInput,
} from './billing-provider.port';

/** Stripe's own subscription.status values, mapped onto this app's narrower enum — `incomplete_expired`/`unpaid` collapse into the closest equivalent this app actually distinguishes on (see this file's own inline comment at the mapping site for why). */
function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

function toDateOrNull(unixSeconds: number | null | undefined): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

@Injectable()
export class StripeBillingProvider extends BillingProvider {
  private client: Stripe | undefined;

  constructor(private readonly config: AppConfigService) {
    super();
  }

  private getClient(): Stripe {
    this.client ??= new Stripe(
      this.config.stripeSecretKey,
      localApiOptions(this.config.stripeApiBaseUrl),
    );
    return this.client;
  }

  async createCustomer(email: string): Promise<string> {
    const customer = await this.getClient().customers.create({ email });
    return customer.id;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<string> {
    const session = await this.getClient().checkout.sessions.create({
      mode: 'subscription',
      customer: input.stripeCustomerId,
      line_items: [{ price: input.stripePriceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      ...(input.trialPeriodDays !== undefined && {
        subscription_data: { trial_period_days: input.trialPeriodDays },
      }),
    });

    if (!session.url) {
      throw new Error(
        'StripeBillingProvider: checkout session created with no url',
      );
    }
    return session.url;
  }

  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<string> {
    const session = await this.getClient().billingPortal.sessions.create({
      customer: input.stripeCustomerId,
      return_url: input.returnUrl,
    });
    return session.url;
  }

  async cancelSubscription(
    input: CancelSubscriptionInput,
  ): Promise<CancelSubscriptionResult> {
    const client = this.getClient();

    // Two genuinely different Stripe calls, not one call with a flag: ending a
    // subscription now is `cancel`, whereas ending it later is an UPDATE that
    // leaves it running. Conflating them is how a "cancel at period end" ends
    // up billing a refund it did not intend.
    const subscription = input.atPeriodEnd
      ? await client.subscriptions.update(input.stripeSubscriptionId, {
          cancel_at_period_end: true,
        })
      : await client.subscriptions.cancel(input.stripeSubscriptionId);

    return {
      status: mapStripeStatus(subscription.status),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: toDateOrNull(
        subscription.items.data[0]?.current_period_end,
      ),
    };
  }

  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): BillingWebhookEvent {
    let event: Stripe.Event;
    try {
      event = this.getClient().webhooks.constructEvent(
        rawBody,
        signature,
        this.config.stripeWebhookSecret,
      );
    } catch {
      // Same "don't leak the specific failure reason" discipline as
      // SupabaseJwtService.verify() — a bad signature could mean a
      // forged request, and confirming exactly why it failed hands an
      // attacker a free oracle.
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return this.mapEvent(event);
  }

  private mapEvent(event: Stripe.Event): BillingWebhookEvent {
    const eventId = event.id;
    const eventCreatedAt = toDateOrNull(event.created);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        return {
          type: 'checkout_completed',
          stripeCustomerId: (session.customer as string) ?? null,
          stripeSubscriptionId: (session.subscription as string) ?? null,
          status: null,
          trialEndsAt: null,
          currentPeriodEnd: null,
          // A checkout says nothing about a scheduled cancellation. Null, not
          // false: "this event does not know" must never overwrite a real flag.
          cancelAtPeriodEnd: null,
          eventId,
          eventCreatedAt,
        };
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const subscription = event.data.object;
        return {
          type: 'subscription_updated',
          stripeCustomerId: subscription.customer as string,
          stripeSubscriptionId: subscription.id,
          status: mapStripeStatus(subscription.status),
          trialEndsAt: toDateOrNull(subscription.trial_end),
          currentPeriodEnd: toDateOrNull(
            subscription.items.data[0]?.current_period_end,
          ),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          eventId,
          eventCreatedAt,
        };
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        return {
          type: 'subscription_deleted',
          stripeCustomerId: subscription.customer as string,
          stripeSubscriptionId: subscription.id,
          status: 'canceled',
          trialEndsAt: null,
          currentPeriodEnd: null,
          // Already gone — there is no pending cancellation left to signal.
          cancelAtPeriodEnd: false,
          eventId,
          eventCreatedAt,
        };
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        return {
          type: 'payment_failed',
          stripeCustomerId: (invoice.customer as string) ?? null,
          stripeSubscriptionId:
            (invoice as unknown as { subscription?: string }).subscription ??
            null,
          status: 'past_due',
          trialEndsAt: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: null,
          eventId,
          eventCreatedAt,
        };
      }
      default:
        return this.ignoredEvent();
    }
  }

  private ignoredEvent(): BillingWebhookEvent {
    const type: BillingWebhookEventType = 'ignored';
    return {
      type,
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

/**
 * Points the SDK at a local Stripe double when STRIPE_API_BASE_URL is set,
 * and at api.stripe.com when it is not.
 *
 * `{ host, port, protocol }` is the SDK's own documented mechanism for this
 * — its v8 migration guide introduces the `protocol` option specifically
 * "for tests and proxies", replacing the deprecated `setHost()`/
 * `setProtocol()` setters — so this is the supported route rather than
 * reaching into the client's internals. envSchema refuses the variable
 * outside development/test, so production always resolves to `undefined`
 * here and keeps the SDK's HTTPS defaults.
 */
function localApiOptions(baseUrl: string | undefined): Stripe.StripeConfig {
  if (!baseUrl) return {};

  const url = new URL(baseUrl);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    host: url.hostname,
    port: Number(url.port || (protocol === 'https' ? 443 : 80)),
    protocol,
  };
}
