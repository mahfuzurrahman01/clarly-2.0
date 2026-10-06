-- A tenant who cancels keeps their subscription until the period they already
-- paid for runs out. That is Stripe's default and the fair behaviour, but it
-- leaves a state this schema could not express: still `active`, and ending.
--
-- Without this column the console can only show "active", so a tenant who has
-- already cancelled sees no confirmation, cannot tell when access stops, and
-- reasonably tries to cancel again.
--
-- Not derivable from `status`: Stripe keeps a period-end cancellation as
-- `active` right up to the moment it ends.

ALTER TABLE "tenant_subscriptions"
  ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;
