// Feature 1 (T5 data model): the tenant registry itself. Deliberately NOT
// RLS-scoped — this table defines what a tenant *is*, so a tenant can't be
// scoped against itself. It's written only by platform-level bootstrapping
// (tenant provisioning, Feature 6's OnboardingModule) and read to validate a
// tenant_id exists, never queried in the hot request path the way
// tenant-scoped tables (e.g. tenant_tools below) are.
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Clarly 2.0 (docs/v2/ARCHITECTURE.md §5): what kind of business a workspace
 * is. Replaces Autologic's `business_type` (`ecommerce` -> `commerce`,
 * `agency` -> `services`). Drives onboarding defaults, console emphasis and
 * which agent tools are seeded; it never forks the prompt.
 */
export const TENANT_VERTICALS = ['commerce', 'services', 'hybrid'] as const;
export type TenantVertical = (typeof TENANT_VERTICALS)[number];

/** Console locales a workspace may default to. Mirrors apps/web LOCALES plus `bn`, which the console gains in a later v2 stage. */
export const TENANT_LOCALES = ['ar', 'en', 'bn'] as const;
export type TenantLocale = (typeof TENANT_LOCALES)[number];

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Set when a tenant admin closes the account. Access stops from this moment,
   * but nothing is deleted yet — closing is reversible, erasing is not.
   */
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /**
   * When the closed tenant's data is actually erased. The grace period between
   * `closedAt` and here is the only window in which a mistaken close, or a
   * compromised admin session, can still be undone — after it, 22 cascading
   * tables, the stored files, and the vector partition are gone for good.
   */
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  /** Migration 0070. Defaults to `commerce`, the v1 behaviour. */
  vertical: text('vertical')
    .$type<TenantVertical>()
    .notNull()
    .default('commerce'),
  /** ISO 3166-1 alpha-2, upper case. Null until the admin sets it. */
  country: text('country'),
  /** ISO 4217, upper case. Null until set: a guessed currency on a price is worse than none. */
  currency: text('currency'),
  /** Migration 0070. `ar` keeps v1's Arabic-first default for existing rows. */
  defaultLocale: text('default_locale')
    .$type<TenantLocale>()
    .notNull()
    .default('ar'),
});
