// Feature 8 (T19): one row per tenant's billing relationship with Stripe.
// RLS-scoped like every other tenant-owned table — unlike `plans`
// (platform catalog) or `tenants` itself, a subscription genuinely is
// tenant data. `unique(tenantId)` — a tenant has at most one active
// subscription row at a time; a plan change updates the existing row
// (via the Stripe subscription update flow), it doesn't create a second
// one.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { plans } from './plans.table';

export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'canceled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    /**
     * Nullable as of Lane A (launch billing backend): a tenant provisioned
     * with a LOCAL trial row (signup, no Stripe interaction yet — see
     * TenantProvisioningService) has no Stripe customer until they either
     * start Checkout or get comped. Every write path that DOES have a
     * Stripe customer (startSubscription, the webhook handler) still
     * always sets this — it is only ever null for a tenant who has not
     * touched Stripe yet.
     */
    stripeCustomerId: text('stripe_customer_id'),
    /** Null until Stripe Checkout actually completes (status starts 'incomplete'). */
    stripeSubscriptionId: text('stripe_subscription_id'),
    status: text('status').notNull().default('incomplete'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /**
     * Set when a tenant has cancelled but their paid period has not run out.
     * Deliberately separate from `status`: Stripe keeps such a subscription
     * `active` right up to the moment it ends, so "active" alone cannot tell
     * a tenant whether they are staying or leaving.
     */
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /**
     * Launch billing backend (Lane A): a platform-operator override, set
     * ONLY by the `scripts/comp-tenant.ts` admin script — never through any
     * API surface, and never by a tenant's own action. A comped tenant is
     * always entitled (UsageService.checkEntitlement()), independent of
     * `status`/`trialEndsAt`, which is exactly the point: comping a tenant
     * (a hand-picked pilot customer, an internal test tenant, a support
     * goodwill gesture) must not require faking a Stripe subscription to
     * get the same allow-decision a paying tenant gets. `compedBy`/
     * `compedAt`/`compedReason` are the audit trail — who set this, when,
     * and why, since it bypasses billing entirely and every use of it
     * should be traceable to a person and a reason.
     */
    comped: boolean('comped').notNull().default(false),
    compedBy: text('comped_by'),
    compedAt: timestamp('comped_at', { withTimezone: true }),
    compedReason: text('comped_reason'),
    /**
     * Launch billing backend (Lane A): Stripe events are NOT guaranteed to
     * arrive in the order they were generated (Stripe's own webhook docs
     * call this out explicitly). Without tracking which event last wrote
     * this row, a late-arriving `incomplete`/`past_due` event for an OLDER
     * state can silently overwrite a NEWER `active` state that already
     * landed — a real tenant with a completed payment could be knocked
     * back to blocked by a stale retry. `handleWebhookEvent()` compares
     * the incoming event's `created` (and falls back to `id` string
     * comparison as a tiebreaker for two events with the same second) to
     * these columns before writing, and skips the write if the incoming
     * event is not newer.
     */
    lastStripeEventCreatedAt: timestamp('last_stripe_event_created_at', {
      withTimezone: true,
    }),
    lastStripeEventId: text('last_stripe_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.tenantId)],
).enableRLS();
