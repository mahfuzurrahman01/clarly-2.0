-- Clarly 2.0 S1 (docs/v2/FEATURE_MATRIX.md): the tenant profile Autologic's
-- business type turns into, and the operator table the platform console needs.
--
-- tenants.vertical replaces Autologic's clients.business_type
-- (ecommerce -> commerce, agency -> services). It decides onboarding defaults,
-- which console sections lead, and which agent tools are seeded. It does NOT
-- fork the prompt (docs/v2/CONFLICTS.md C5).
--
-- country / currency are nullable on purpose: existing tenants have neither,
-- and a guessed currency on a price is worse than an absent one.
-- default_locale keeps the v1 behaviour (Arabic first) for existing rows.
--
-- `tenants` has no RLS (platform directory, see 0019), so neither do these
-- columns. platform_admins follows the same rule as `plans`: a platform
-- table, never read from a tenant path; the only reader is PlatformModule.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "vertical" text NOT NULL DEFAULT 'commerce';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "country" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "currency" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "default_locale" text NOT NULL DEFAULT 'ar';--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_vertical_check"
  CHECK ("vertical" IN ('commerce', 'services', 'hybrid'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_country_check"
  CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_currency_check"
  CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_locale_check"
  CHECK ("default_locale" IN ('ar', 'en', 'bn'));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_admins" (
  "user_id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "granted_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "platform_admins_role_check" CHECK ("role" IN ('owner', 'staff', 'viewer')),
  CONSTRAINT "platform_admins_email_unique" UNIQUE ("email")
);
