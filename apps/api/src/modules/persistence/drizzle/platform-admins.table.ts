import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Clarly 2.0 S1: who may use the operator console (`/platform/*`).
 *
 * A platform table like `plans` and `tenants`: no RLS, never read from a
 * tenant-scoped path. The only reader is PlatformAdminService. Being in this
 * table is the ONLY thing that grants operator access — tenant roles
 * (`admin` / `agent` in the JWT) never do, so a tenant admin cannot reach
 * another tenant's data by any role escalation inside their own workspace.
 *
 * `owner` may grant and revoke operators and change platform settings;
 * `staff` may act on tenants (suspend, comp, assign plan); `viewer` reads.
 */
export const PLATFORM_ROLES = ['owner', 'staff', 'viewer'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const platformAdmins = pgTable('platform_admins', {
  /** Supabase auth user id (`sub`). */
  userId: uuid('user_id').primaryKey(),
  email: text('email').notNull().unique('platform_admins_email_unique'),
  role: text('role').$type<PlatformRole>().notNull(),
  grantedBy: uuid('granted_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
