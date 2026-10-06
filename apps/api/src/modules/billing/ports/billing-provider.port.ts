// BillingModule (Feature 8, T19): the D1-style provider-portability port
// for Stripe operations — kept as a port (not direct SDK calls from
// BillingService) for the same reason LlmProvider/Embedder/
// TenantAuthProvisioningPort are ports: a test double is a binding
// change, never a call-site change, and this is exactly what lets
// BillingService be unit-tested without a real Stripe account.
import type { SubscriptionStatus } from '../../persistence/drizzle/tenant-subscriptions.table';

export interface CreateCheckoutSessionInput {
  stripeCustomerId: string;
  stripePriceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Stripe Checkout's own trial mechanism — set from the tenant's plan, not hardcoded here. */
  trialPeriodDays?: number;
}

export interface CreateBillingPortalSessionInput {
  stripeCustomerId: string;
  /** Absolute URL Stripe returns the tenant to when they close the portal. */
  returnUrl: string;
}

export interface CancelSubscriptionInput {
  stripeSubscriptionId: string;
  /**
   * True (the default the caller should prefer) keeps the subscription running
   * until the period the tenant already paid for runs out. False ends it now
   * and forfeits the remainder — a refund decision, not a technical one, which
   * is why it is the caller's explicit choice rather than a default here.
   */
  atPeriodEnd: boolean;
}

export interface CancelSubscriptionResult {
  status: SubscriptionStatus;
  /** True while a cancellation is scheduled but the paid period is still running. */
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
}

/**
 * Normalized shape BillingService actually needs, deliberately narrower
 * than Stripe's own `Event` object — only the handful of event types this
 * app currently acts on are mapped to a real `type`; everything else
 * (Stripe sends dozens of event types the app has no opinion on) comes
 * back as `'ignored'` so BillingService can no-op cleanly rather than the
 * caller needing to know Stripe's full event taxonomy.
 */
export type BillingWebhookEventType =
  | 'checkout_completed'
  | 'subscription_updated'
  | 'subscription_deleted'
  | 'payment_failed'
  | 'ignored';

export interface BillingWebhookEvent {
  type: BillingWebhookEventType;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /**
   * Whether Stripe currently has a cancellation scheduled for the end of the
   * paid period. Carried because a cancellation can also be made or undone in
   * the Stripe dashboard or the hosted portal, not only through this API — the
   * webhook is the only way we hear about those.
   */
  cancelAtPeriodEnd: boolean | null;
  /**
   * Launch billing backend (Lane A): Stripe's own `event.created` (and
   * `event.id` as a same-second tiebreaker) — NOT guaranteed delivery
   * order (Stripe's webhook docs call this out explicitly). BillingService.
   * handleWebhookEvent() uses these to refuse writing a late-arriving event
   * over a row a newer event already updated. Both null for an `ignored`
   * event, which never reaches that comparison.
   */
  eventId: string | null;
  eventCreatedAt: Date | null;
}

export abstract class BillingProvider {
  abstract createCustomer(email: string): Promise<string>;

  /** Returns the Stripe-hosted checkout URL to redirect the tenant admin to. */
  abstract createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<string>;

  /**
   * A Stripe-hosted billing portal session.
   *
   * One URL covers cancelling, changing a card, and downloading past invoices.
   * That is deliberately NOT reimplemented in this API: the portal is PCI-
   * handled, localized, and kept current by Stripe, and rebuilding it would
   * mean holding card details this system has no business seeing.
   */
  abstract createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<string>;

  /**
   * Ends a subscription, by default at the end of the paid period.
   *
   * Exists alongside the portal because a tenant must be able to leave through
   * the product they bought, without being handed off to a third-party page —
   * and because the product needs to know a cancellation happened, which a
   * portal redirect does not tell it until a webhook arrives.
   */
  abstract cancelSubscription(
    input: CancelSubscriptionInput,
  ): Promise<CancelSubscriptionResult>;

  /** Verifies the webhook signature (never trust payload content alone — Stripe's own guidance) and maps to the normalized event shape above. Throws if signature verification fails. */
  abstract constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): BillingWebhookEvent;
}
