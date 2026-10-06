// Feature 8 (T19): the plan catalog. Deliberately NOT RLS-scoped, same
// reasoning as `tenants.table.ts` — a plan isn't tenant data, it's
// platform-level config every tenant reads the same rows from (e.g. to
// show pricing options during signup). Written only by platform-level
// seeding (script, no admin endpoint this pass — same "seed only" start
// every other config table in this codebase began with, T15's
// tenant_policy being the most direct precedent).
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
} from 'drizzle-orm/pg-core';

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Stripe Price object id (`price_...`) — the actual billable unit Stripe checkout references. */
  stripePriceId: text('stripe_price_id').notNull(),
  /** T20's entitlement basis — plan-gating checks usage against this. */
  monthlyMessageLimit: integer('monthly_message_limit').notNull(),
  /** T17/T20's spend-cap basis, USD. */
  monthlySpendCapUsd: numeric('monthly_spend_cap_usd', {
    mode: 'number',
    precision: 10,
    scale: 2,
  }).notNull(),
  /** Passed straight to Stripe Checkout's own `subscription_data.trial_period_days` — 0 means no trial. */
  trialDays: integer('trial_days').notNull().default(14),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
