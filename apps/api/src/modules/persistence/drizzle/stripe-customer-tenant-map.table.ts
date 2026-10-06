// Feature 8 (T19): resolves a Stripe webhook's `customer` id to a
// tenantId BEFORE any tenant context exists — same exact role, and same
// reasoning, as `whatsapp_numbers.table.ts`'s "resolve phone_number_id ->
// tenant_id before tenant context exists" comment (T6's own webhook
// tenant-resolution precedent). Deliberately NOT RLS-scoped, for the same
// reason: `tenant_subscriptions` (which DOES need RLS — it's genuinely
// tenant data an admin reads via GET /billing/subscription) is FORCE ROW
// LEVEL SECURITY, so a cross-tenant lookup against it via
// PersistenceService.runAdminQuery() (no `app.tenant_id` GUC set) would
// silently return zero rows — RLS doesn't distinguish "wrong tenant" from
// "no tenant context at all," both just fail the policy predicate. This
// tiny mapping table is the one thing read outside any tenant context;
// `stripeCustomerId` alone (no other columns) means there's nothing
// sensitive in it to leak even though it has no RLS policy.
import { pgTable, text, uuid, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const stripeCustomerTenantMap = pgTable('stripe_customer_tenant_map', {
  stripeCustomerId: text('stripe_customer_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
