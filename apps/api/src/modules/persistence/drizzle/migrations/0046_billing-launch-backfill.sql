-- Launch billing backend (Lane A): data backfill, run once, immediately
-- after 0045 adds `comped`/nullable `stripe_customer_id`.
--
-- Before this pass, RespondPathProcessor never checked subscription status
-- at all — every tenant got AI replies regardless of billing state. This
-- pass adds a real entitlement check to the worker's blocked path
-- (UsageService.checkEntitlement(), called before AgentRuntime.respond()).
-- Deployed without a backfill, that change would retroactively cut off
-- every tenant who is not cleanly `active` or mid-trial today — most of
-- which are pre-launch/internal/pilot tenants that were never actually
-- billed, not tenants who genuinely lapsed.
--
-- Decision (explicit, not a silent default): every tenant that is not
-- unambiguously `active` or currently inside a real trial window gets
-- `comped = true` here, not a fabricated trial. A fabricated trial would
-- imply a trial_ends_at this tenant never agreed to and would expire on its
-- own later, silently cutting the tenant off a second time with no operator
-- in the loop. `comped` instead stays true until a human (via
-- scripts/comp-tenant.ts or a real Stripe subscription reaching `active`)
-- makes a deliberate decision about that tenant. This is a one-time launch-
-- day safety net, not a permanent entitlement mechanism.
--
-- Two cases:
--   1. A tenant with no tenant_subscriptions row at all (the common case
--      pre-launch, since billing enforcement did not exist until now) gets
--      one created, comped, against whichever plan was seeded first. The
--      plan_id is required by the FK but is never read for a comped
--      tenant's entitlement decision (UsageService.checkEntitlement() short-
--      circuits on `comped` before touching usage/plan caps).
--   2. A tenant that already has a row, but is not `active` and not inside
--      a live trial window, gets that existing row flipped to `comped`
--      rather than a second row (tenant_subscriptions.tenant_id is unique).

DO $$
DECLARE
  default_plan_id uuid;
BEGIN
  SELECT id INTO default_plan_id FROM "plans" ORDER BY "created_at" ASC LIMIT 1;

  -- No plan seeded yet (a fresh/empty environment) — nothing to backfill
  -- against, and no tenant can have a real subscription row either in that
  -- case, so this is a no-op rather than an error.
  IF default_plan_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "tenant_subscriptions" (
    "tenant_id",
    "plan_id",
    "stripe_customer_id",
    "status",
    "comped",
    "comped_by",
    "comped_at",
    "comped_reason"
  )
  SELECT
    t."id",
    default_plan_id,
    NULL,
    'incomplete',
    true,
    'launch-backfill-0043',
    now(),
    'Launch billing backend backfill: tenant had no subscription row when entitlement enforcement was added to the respond path; comped so it keeps receiving AI replies until billing is set up for it.'
  FROM "tenants" t
  WHERE NOT EXISTS (
    SELECT 1 FROM "tenant_subscriptions" s WHERE s."tenant_id" = t."id"
  );

  UPDATE "tenant_subscriptions"
  SET
    "comped" = true,
    "comped_by" = 'launch-backfill-0043',
    "comped_at" = now(),
    "comped_reason" = 'Launch billing backend backfill: existing subscription status would newly be blocked once entitlement enforcement reaches the respond path; comped so it keeps receiving AI replies until billing is set up for it.',
    "updated_at" = now()
  WHERE "comped" = false
    AND "status" <> 'active'
    AND NOT ("status" = 'trialing' AND "trial_ends_at" IS NOT NULL AND "trial_ends_at" > now());
END $$;
