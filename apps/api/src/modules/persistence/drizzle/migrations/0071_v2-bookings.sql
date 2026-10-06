-- Clarly 2.0 S2 (docs/v2/FEATURE_MATRIX.md, "Services"): appointments, ported
-- from Autologic's agency mode and rebuilt as tables + agent tools.
--
-- Four tables, all FORCE RLS with the standard app.tenant_id policy:
--   tenant_booking_settings  one row per tenant; ABSENT means disabled (fail
--                            closed, same posture as tenant_order_settings:
--                            an appointment is a promise made on the
--                            business's behalf)
--   booking_services         what can be booked: duration, buffer, price
--   calendar_connections     the tenant's Google Calendar, credentials
--                            encrypted by the app (never stored in clear)
--   bookings                 the appointment of record, with snapshots of
--                            the service name/buffer/time zone at booking time
--
-- Double booking is prevented in the application under a per-tenant
-- transaction advisory lock (BookingService.create), not with an EXCLUDE
-- constraint: that needs btree_gist, which app_user cannot CREATE EXTENSION,
-- and a migration that fails on the hosted database helps nobody.

CREATE TABLE IF NOT EXISTS "tenant_booking_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'disabled',
  "time_zone" text NOT NULL,
  "weekly_hours" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "slot_interval_minutes" integer NOT NULL DEFAULT 30,
  "min_notice_minutes" integer NOT NULL DEFAULT 60,
  "max_days_ahead" integer NOT NULL DEFAULT 30,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_booking_settings_mode_check"
    CHECK ("mode" IN ('disabled', 'request', 'auto')),
  CONSTRAINT "tenant_booking_settings_interval_check"
    CHECK ("slot_interval_minutes" BETWEEN 5 AND 240),
  CONSTRAINT "tenant_booking_settings_notice_check"
    CHECK ("min_notice_minutes" BETWEEN 0 AND 10080),
  CONSTRAINT "tenant_booking_settings_ahead_check"
    CHECK ("max_days_ahead" BETWEEN 1 AND 365)
);--> statement-breakpoint
ALTER TABLE "tenant_booking_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_booking_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_booking_settings_isolation" ON "tenant_booking_settings";--> statement-breakpoint
CREATE POLICY "tenant_booking_settings_isolation" ON "tenant_booking_settings"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "booking_services" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "duration_minutes" integer NOT NULL,
  "buffer_minutes" integer NOT NULL DEFAULT 0,
  "price" numeric(12,2),
  "currency" text,
  "location" text NOT NULL DEFAULT 'in_person',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "booking_services_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "booking_services_duration_check" CHECK ("duration_minutes" BETWEEN 5 AND 480),
  CONSTRAINT "booking_services_buffer_check" CHECK ("buffer_minutes" BETWEEN 0 AND 240),
  CONSTRAINT "booking_services_price_check" CHECK ("price" IS NULL OR "price" >= 0),
  CONSTRAINT "booking_services_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "booking_services_location_check" CHECK ("location" IN ('in_person', 'online', 'phone')),
  CONSTRAINT "booking_services_name_check" CHECK (length(btrim("name")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_services_tenant_name_idx"
  ON "booking_services" ("tenant_id", lower("name"));--> statement-breakpoint
ALTER TABLE "booking_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_services" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "booking_services_isolation" ON "booking_services";--> statement-breakpoint
CREATE POLICY "booking_services_isolation" ON "booking_services"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "calendar_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "account_email" text,
  "calendar_id" text NOT NULL DEFAULT 'primary',
  "credentials_encrypted" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "last_error" text,
  "connected_by" uuid,
  "state_nonce" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "calendar_connections_tenant_unique" UNIQUE ("tenant_id"),
  CONSTRAINT "calendar_connections_provider_check" CHECK ("provider" IN ('google')),
  CONSTRAINT "calendar_connections_status_check" CHECK ("status" IN ('active', 'needs_reconnect'))
);--> statement-breakpoint
ALTER TABLE "calendar_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "calendar_connections_isolation" ON "calendar_connections";--> statement-breakpoint
CREATE POLICY "calendar_connections_isolation" ON "calendar_connections"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "reference" text NOT NULL,
  "service_id" uuid NOT NULL,
  "customer_id" uuid,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "status" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "buffer_minutes" integer NOT NULL DEFAULT 0,
  "time_zone" text NOT NULL,
  "service_name" text NOT NULL,
  "location" text NOT NULL,
  "customer_name" text NOT NULL,
  "customer_phone" text,
  "customer_email" text,
  "notes" text,
  "meeting_url" text,
  "calendar_event_id" text,
  "calendar_sync_status" text NOT NULL DEFAULT 'not_applicable',
  "calendar_sync_error" text,
  "source" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_by" uuid,
  "confirmed_at" timestamptz,
  "confirmed_by" uuid,
  "cancelled_at" timestamptz,
  "cancel_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bookings_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "bookings_tenant_reference_unique" UNIQUE ("tenant_id", "reference"),
  CONSTRAINT "bookings_tenant_idempotency_unique" UNIQUE ("tenant_id", "idempotency_key"),
  -- NO ACTION (checked at end of statement), not RESTRICT: a tenant purge
  -- cascades to both tables in one statement, and RESTRICT would make that
  -- depend on which cascade Postgres happens to run first. Services are never
  -- deleted by the API (deactivated instead), so nothing else relies on it.
  CONSTRAINT "bookings_service_fk" FOREIGN KEY ("tenant_id", "service_id")
    REFERENCES "booking_services"("tenant_id", "id") ON DELETE NO ACTION,
  CONSTRAINT "bookings_customer_fk" FOREIGN KEY ("tenant_id", "customer_id")
    REFERENCES "customers"("tenant_id", "id") ON DELETE SET NULL ("customer_id"),
  CONSTRAINT "bookings_status_check"
    CHECK ("status" IN ('requested', 'confirmed', 'cancelled', 'completed', 'no_show')),
  CONSTRAINT "bookings_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "bookings_location_check" CHECK ("location" IN ('in_person', 'online', 'phone')),
  CONSTRAINT "bookings_source_check" CHECK ("source" IN ('agent', 'console')),
  CONSTRAINT "bookings_calendar_sync_check"
    CHECK ("calendar_sync_status" IN ('not_applicable', 'pending', 'synced', 'failed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_tenant_active_start_idx"
  ON "bookings" ("tenant_id", "starts_at")
  WHERE "status" IN ('requested', 'confirmed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_tenant_status_start_idx"
  ON "bookings" ("tenant_id", "status", "starts_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_tenant_customer_idx"
  ON "bookings" ("tenant_id", "customer_id");--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "bookings_isolation" ON "bookings";--> statement-breakpoint
CREATE POLICY "bookings_isolation" ON "bookings"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
