// BillingModule (Feature 8, T19): "Plan/subscription schema, payment
// provider integration (Stripe), plan-gating on tenant-scoped endpoints,
// trial/dunning flow." This service owns the plan-catalog read + the
// subscription write path; plan-gating enforcement (a guard consuming
// `getForTenant()`) is a separate, not-yet-built slice.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  plans,
  stripeCustomerTenantMap,
  tenantSubscriptions,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BillingProvider } from './ports/billing-provider.port';
import type {
  PlanRecord,
  PublicPlanRecord,
  StartSubscriptionResult,
  TenantSubscriptionRecord,
} from './billing.dto';

function toPlanRecord(row: typeof plans.$inferSelect): PlanRecord {
  return {
    id: row.id,
    name: row.name,
    stripePriceId: row.stripePriceId,
    monthlyMessageLimit: row.monthlyMessageLimit,
    monthlySpendCapUsd: row.monthlySpendCapUsd,
    trialDays: row.trialDays,
  };
}

function toSubscriptionRecord(
  row: typeof tenantSubscriptions.$inferSelect,
): TenantSubscriptionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    planId: row.planId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    status: row.status as TenantSubscriptionRecord['status'],
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    comped: row.comped,
  };
}

/** Stripe statuses in which a completed Checkout still counts as paid for D7. */
const PAID_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

@Injectable()
export class BillingService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly billingProvider: BillingProvider,
  ) {}

  /** No admin endpoint for writing plans this pass (same "seed only" start as T15's tenant_policy) — read-only here. */
  async listPlans(): Promise<PlanRecord[]> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db.select().from(plans),
    );
    return rows.map(toPlanRecord);
  }

  /**
   * Launch billing backend (Lane A, frontend contract request): the public,
   * unauthenticated read behind GET /billing/plans/public — /pricing is a
   * signed-out page, and `listPlans()` above sits behind `@Roles('admin')`.
   * Strips `stripePriceId` (an internal identifier a visitor has no use
   * for) rather than adding a second query; the plan catalog is small and
   * not RLS-scoped, so there is no cost to reusing the same read.
   */
  async listPublicPlans(): Promise<PublicPlanRecord[]> {
    const rows = await this.listPlans();
    return rows.map((plan) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop it from the public projection.
      const { stripePriceId, ...rest } = plan;
      return rest;
    });
  }

  /**
   * Launch billing backend (Lane A): called once, from
   * TenantProvisioningService.signUp(), immediately after a tenant is
   * created. Writes a LOCAL trial row — `status: 'trialing'`,
   * `trialEndsAt` set from the plan's own `trialDays`, `stripeCustomerId:
   * null` — with no Stripe interaction at all. A brand-new tenant gets AI
   * replies immediately, without ever having entered a card, and without
   * this app creating a Stripe customer (and therefore a trial) for
   * someone who may never come back to actually subscribe.
   *
   * `startSubscription()` is what later turns this same row into a real
   * Stripe subscription (see that method's own header comment on
   * `isLocalTrial`) — it does not create a second row and does not grant
   * a second Stripe trial on top of this one.
   *
   * Silently no-ops when no plan is seeded yet (a fresh/empty
   * environment) — signup must not fail because the platform's own plan
   * catalog hasn't been seeded; the tenant simply has no subscription row
   * until one is, same as any tenant created before this method existed
   * (see migration 0046's backfill for that case).
   */
  async startLocalTrial(tenantId: string): Promise<void> {
    const [planRow] = await this.persistence.runAdminQuery((db) =>
      db.select().from(plans).orderBy(plans.createdAt).limit(1),
    );
    if (!planRow) return;

    const trialEndsAt =
      planRow.trialDays > 0
        ? new Date(Date.now() + planRow.trialDays * 24 * 60 * 60 * 1000)
        : new Date(); // 0-trial-day plan: trial row that is already expired, so checkEntitlement() blocks immediately rather than granting an unintended free period.

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantSubscriptions).values({
          tenantId,
          planId: planRow.id,
          stripeCustomerId: null,
          status: 'trialing',
          trialEndsAt,
        }),
      tenantId,
    );
  }

  async getForTenant(
    tenantId: string,
  ): Promise<TenantSubscriptionRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantSubscriptions)
          .where(eq(tenantSubscriptions.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toSubscriptionRecord(rows[0]) : null;
  }

  /**
   * First-time subscribe, OR a tenant converting a LOCAL trial row
   * (TenantProvisioningService's signup-time row: `trialing`, no Stripe
   * customer) into a real Stripe subscription. A tenant already `active`,
   * or already `trialing` with a REAL Stripe subscription behind it, gets
   * a 409 — never a silent second Stripe customer or checkout session.
   * Plan-change/upgrade flows (which need a Stripe subscription *update*,
   * not a new Checkout Session) are a separate, not-yet-built slice.
   *
   * Launch billing backend (Lane A): distinguishing "local trial, not yet
   * through Stripe" from "already has a Stripe subscription" is
   * `existing.stripeCustomerId === null` — that column is null for
   * exactly one reason (see tenant-subscriptions.table.ts's own header
   * comment): a row created by signup that has never talked to Stripe.
   * Once this method runs for it, that stops being true — the row either
   * gets an existing Stripe customer id reused or a new one created, same
   * as any other tenant.
   */
  async startSubscription(
    tenantId: string,
    planId: string,
    email: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<StartSubscriptionResult> {
    const [planRow] = await this.persistence.runAdminQuery((db) =>
      db.select().from(plans).where(eq(plans.id, planId)).limit(1),
    );
    if (!planRow) {
      throw new NotFoundException(`Plan ${planId} not found`);
    }
    const plan = toPlanRecord(planRow);

    const existing = await this.getForTenant(tenantId);
    const isLocalTrial =
      existing !== null && existing.stripeCustomerId === null;
    if (
      existing &&
      !isLocalTrial &&
      (existing.status === 'active' || existing.status === 'trialing')
    ) {
      throw new ConflictException(
        'This tenant already has an active subscription.',
      );
    }

    let stripeCustomerId = existing?.stripeCustomerId ?? null;
    if (!stripeCustomerId) {
      const newStripeCustomerId =
        await this.billingProvider.createCustomer(email);
      // Written outside any tenant context (not RLS-scoped, see
      // stripe-customer-tenant-map.table.ts's own header comment) — this
      // is what makes the webhook path below able to resolve a tenant at
      // all, since a Stripe event carries only the customer id, never
      // this app's tenantId.
      await this.persistence.runAdminQuery((db) =>
        db
          .insert(stripeCustomerTenantMap)
          .values({ stripeCustomerId: newStripeCustomerId, tenantId }),
      );
      stripeCustomerId = newStripeCustomerId;
    }

    if (existing) {
      await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(tenantSubscriptions)
            .set({ planId, stripeCustomerId, updatedAt: new Date() })
            .where(eq(tenantSubscriptions.tenantId, tenantId)),
        tenantId,
      );
    } else {
      await this.tenantContext.withTenantTx(
        (tx) =>
          tx.insert(tenantSubscriptions).values({
            tenantId,
            planId,
            stripeCustomerId,
            status: 'incomplete',
          }),
        tenantId,
      );
    }

    const checkoutUrl = await this.billingProvider.createCheckoutSession({
      stripeCustomerId,
      stripePriceId: plan.stripePriceId,
      successUrl,
      cancelUrl,
      // No second Stripe trial for a tenant who already used a local
      // trial (or any prior trial — `existing.trialEndsAt !== null`
      // covers both) — Stripe Checkout's own trial mechanism is only
      // offered to a genuinely first-time subscriber.
      trialPeriodDays:
        plan.trialDays > 0 && !existing?.trialEndsAt
          ? plan.trialDays
          : undefined,
    });

    return { checkoutUrl };
  }

  /**
   * D7's "card required to connect [a WhatsApp channel]" gate — the
   * narrow question the connect flow actually needs answered, without
   * handing it the whole subscription record (or this module's other
   * internals) to interpret itself.
   *
   * Deliberately keyed on `stripeSubscriptionId !== null`, matching the
   * frontend's own "paid/card on file" check (Lane A/frontend contract):
   * a non-null `stripeSubscriptionId` means Checkout actually completed
   * and Stripe has a card on file for this tenant, even if that
   * subscription is still `trialing` in Stripe's own terms (a card was
   * captured either way). `status === 'active'` alone would say "no" for
   * that mid-Stripe-trial tenant, which is wrong for D7's purposes — the
   * card is already on file, which is the thing D7 actually gates on.
   * `comped` still counts as paid: a platform operator granting
   * entitlement is exactly as much "allowed to connect a channel" as a
   * real card on file. A LOCAL trial row (signup, pre-Checkout) has
   * `stripeSubscriptionId: null` by construction (see
   * BillingService.startLocalTrial()) and so correctly reads as unpaid
   * here until the tenant actually goes through Checkout.
   */
  async hasPaidSubscription(tenantId: string): Promise<boolean> {
    const subscription = await this.getForTenant(tenantId);
    if (!subscription) return false;
    if (subscription.comped) return true;
    // A canceled/past_due/incomplete Stripe subscription keeps its id, so the
    // id alone is not enough — the card must also still be in good standing.
    return (
      subscription.stripeSubscriptionId !== null &&
      PAID_STATUSES.has(subscription.status)
    );
  }

  /**
   * A Stripe-hosted billing portal session for the calling tenant.
   *
   * One URL covers changing a card, downloading past invoices, and cancelling.
   * Deliberately not reimplemented in this API: the portal is PCI-handled and
   * kept current by Stripe, and rebuilding it would mean holding card details
   * this system has no business seeing.
   *
   * 409 rather than 404 when the tenant never subscribed — there is nothing
   * wrong with the request, there is simply no billing relationship to manage
   * yet, and the fix is to subscribe rather than to retry.
   */
  async createPortalSession(
    tenantId: string,
    returnUrl: string,
  ): Promise<{ portalUrl: string }> {
    const subscription = await this.getForTenant(tenantId);
    // Launch billing backend (Lane A): a LOCAL trial row (signup, never
    // through Checkout) has `stripeCustomerId: null` — Stripe has no
    // customer to open a portal session for. Same 409 as "no subscription
    // at all": nothing is wrong with the request, there is just no real
    // Stripe billing relationship yet, and the fix is to start Checkout.
    if (!subscription || subscription.stripeCustomerId === null) {
      throw new ConflictException(
        'This tenant has no billing relationship yet. Start a subscription before opening the billing portal.',
      );
    }

    const portalUrl = await this.billingProvider.createBillingPortalSession({
      stripeCustomerId: subscription.stripeCustomerId,
      returnUrl,
    });
    return { portalUrl };
  }

  /**
   * Cancels the tenant's subscription — by default at the end of the period
   * they have already paid for.
   *
   * Exists alongside the portal because a tenant must be able to leave through
   * the product they bought rather than being handed to a third-party page.
   * Being unable to cancel is not a missing feature, it is a chargeback and,
   * in most jurisdictions, a consumer-law problem.
   *
   * Writes the returned state locally rather than waiting for the webhook, so
   * the tenant's very next read reflects what they just did. The webhook still
   * arrives and writes the same values; both paths converge, and Stripe stays
   * the source of truth for anything they change elsewhere.
   */
  async cancelSubscription(
    tenantId: string,
    atPeriodEnd: boolean,
  ): Promise<TenantSubscriptionRecord> {
    const subscription = await this.getForTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException('This tenant has no subscription to cancel.');
    }
    if (!subscription.stripeSubscriptionId) {
      // Checkout was started but never completed, so Stripe has a customer and
      // no subscription. Nothing is being billed; there is nothing to cancel.
      throw new ConflictException(
        'This tenant has no active subscription — checkout was never completed, so nothing is being billed.',
      );
    }
    if (subscription.status === 'canceled') {
      throw new ConflictException('This subscription is already cancelled.');
    }

    const result = await this.billingProvider.cancelSubscription({
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      atPeriodEnd,
    });

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tenantSubscriptions)
          .set({
            status: result.status,
            cancelAtPeriodEnd: result.cancelAtPeriodEnd,
            ...(result.currentPeriodEnd !== null && {
              currentPeriodEnd: result.currentPeriodEnd,
            }),
            updatedAt: new Date(),
          })
          .where(eq(tenantSubscriptions.tenantId, tenantId))
          .returning(),
      tenantId,
    );

    return toSubscriptionRecord(row);
  }

  /**
   * Webhooks carry no tenant context (Stripe doesn't know this app's
   * tenant ids) — resolving one is a two-step lookup, deliberately NOT a
   * single cross-tenant query against `tenant_subscriptions` itself:
   * that table is FORCE ROW LEVEL SECURITY (it's genuinely tenant data,
   * read directly by a tenant admin via GET /billing/subscription), so a
   * `PersistenceService.runAdminQuery()` read against it — no
   * `app.tenant_id` GUC set — would silently return zero rows every
   * time, not an error (RLS can't distinguish "wrong tenant" from "no
   * tenant context at all"). `stripeCustomerTenantMap` is the
   * purpose-built, NOT-RLS-scoped table (same role as `whatsapp_numbers`
   * for T6's webhook tenant resolution) that step 1 reads instead; step
   * 2 is the normal `withTenantTx()` path once the tenant is actually
   * known.
   */
  /**
   * Launch billing backend (Lane A): stale events are ignored, not applied.
   *
   * Stripe does not guarantee webhook delivery order — a retried or
   * out-of-order `invoice.payment_failed` can arrive AFTER a
   * `customer.subscription.updated` that already moved the row to
   * `active`. Applying it anyway would knock a genuinely paying tenant
   * back to `past_due` off a stale event, which is exactly the "late
   * `incomplete` can't overwrite `active`" failure mode this pass exists
   * to close. The WHERE clause below is the enforcement: the UPDATE only
   * touches the row when the incoming event is newer than whatever last
   * wrote it (by `created`, falling back to `id` as a same-second
   * tiebreaker) or nothing has written it yet — done as a single
   * conditional UPDATE, not a read-then-write, so two events racing each
   * other can't both pass a staleness check taken before either wrote.
   */
  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<void> {
    const event = this.billingProvider.constructWebhookEvent(
      rawBody,
      signature,
    );
    if (event.type === 'ignored' || !event.stripeCustomerId) return;

    const [mapping] = await this.persistence.runAdminQuery((db) =>
      db
        .select({ tenantId: stripeCustomerTenantMap.tenantId })
        .from(stripeCustomerTenantMap)
        .where(
          eq(stripeCustomerTenantMap.stripeCustomerId, event.stripeCustomerId!),
        )
        .limit(1),
    );
    if (!mapping) return;

    const tenantId = mapping.tenantId;

    const notStale = !event.eventCreatedAt
      ? undefined // no ordering info on this event — never expected once eventId/eventCreatedAt are always populated for a non-ignored event, but fail open rather than silently drop a real update.
      : or(
          isNull(tenantSubscriptions.lastStripeEventCreatedAt),
          lt(
            tenantSubscriptions.lastStripeEventCreatedAt,
            event.eventCreatedAt,
          ),
          and(
            eq(
              tenantSubscriptions.lastStripeEventCreatedAt,
              event.eventCreatedAt,
            ),
            or(
              isNull(tenantSubscriptions.lastStripeEventId),
              lt(tenantSubscriptions.lastStripeEventId, event.eventId ?? ''),
            ),
          ),
        );

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tenantSubscriptions)
          .set({
            ...(event.stripeSubscriptionId && {
              stripeSubscriptionId: event.stripeSubscriptionId,
            }),
            ...(event.status && { status: event.status }),
            ...(event.trialEndsAt !== null && {
              trialEndsAt: event.trialEndsAt,
            }),
            ...(event.currentPeriodEnd !== null && {
              currentPeriodEnd: event.currentPeriodEnd,
            }),
            // Null means this event type says nothing about a scheduled
            // cancellation, so the stored flag must survive it. Also the only
            // way we hear about a cancel made in Stripe's own dashboard or the
            // hosted portal rather than through this API.
            ...(event.cancelAtPeriodEnd !== null && {
              cancelAtPeriodEnd: event.cancelAtPeriodEnd,
            }),
            ...(event.eventCreatedAt && {
              lastStripeEventCreatedAt: event.eventCreatedAt,
              lastStripeEventId: event.eventId,
            }),
            updatedAt: new Date(),
          })
          .where(
            notStale === undefined
              ? eq(tenantSubscriptions.tenantId, tenantId)
              : and(eq(tenantSubscriptions.tenantId, tenantId), notStale),
          ),
      tenantId,
    );
  }
}
