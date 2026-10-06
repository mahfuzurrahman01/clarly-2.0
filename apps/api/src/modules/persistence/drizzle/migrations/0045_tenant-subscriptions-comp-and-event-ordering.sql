-- Launch billing backend (Lane A): three independent changes to
-- tenant_subscriptions, bundled in one migration because they all touch the
-- same table and the backfill migration right after this one depends on all
-- three existing.
--
-- 1. stripe_customer_id becomes nullable. A tenant provisioned by signup now
--    gets a LOCAL trial row (status='trialing', trial_ends_at set, no Stripe
--    interaction at all) — see TenantProvisioningService. That row has no
--    Stripe customer until the tenant either starts Checkout or a platform
--    operator comps them. Every write path that DOES talk to Stripe
--    (BillingService.startSubscription, the webhook handler) continues to
--    always set this column; it is only ever null for a tenant who has not
--    touched Stripe yet.
--
-- 2. comped (+ its audit trail: comped_by/comped_at/comped_reason). A
--    platform-operator override, set ONLY by scripts/comp-tenant.ts — never
--    through any API surface. A comped tenant is always entitled
--    (UsageService.checkEntitlement()), independent of status/trial_ends_at.
--    The audit columns exist because bypassing billing entirely must always
--    be traceable to a person and a reason, not just a boolean flip.
--
-- 3. last_stripe_event_created_at / last_stripe_event_id. Stripe does not
--    guarantee webhook delivery order (Stripe's own docs call this out).
--    Without tracking which event last wrote a row, a late-arriving
--    `incomplete`/`past_due` retry for an OLDER state can silently overwrite
--    a NEWER `active` state that already landed. BillingService.
--    handleWebhookEvent() now compares the incoming event's `created`
--    (falling back to `id` as a string tiebreaker) against these columns
--    before writing, and skips stale events.

ALTER TABLE "tenant_subscriptions"
  ALTER COLUMN "stripe_customer_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "comped" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "comped_by" text;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "comped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "comped_reason" text;
--> statement-breakpoint

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "last_stripe_event_created_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "last_stripe_event_id" text;
