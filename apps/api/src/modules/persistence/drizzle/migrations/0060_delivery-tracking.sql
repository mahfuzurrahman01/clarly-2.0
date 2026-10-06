-- F26 (Delivery Tracking — Aramex, SMSA, Naqel, J&T).
-- Spec: docs/decisions/F26-delivery-tracking.md, D3 (data model), D7 (RLS),
-- D4 (the track_order tenant_tools backfill at the bottom of this file).
--
-- Ordered AFTER F25's 0059, because `shipments.order_id` takes a foreign key
-- on `orders`, which F25 creates.
--
-- Six tables:
--   courier_connections            — per-tenant courier links, encrypted creds
--   shipments                      — one row per tracked parcel
--   shipment_status_events         — normalized status history
--   shipment_notifications         — the "already told them" claim log
--   delivery_notification_settings — per-tenant opt-in + status->template map
--   courier_webhook_events         — push-callback idempotency log (no RLS)

CREATE TABLE IF NOT EXISTS "courier_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "courier" text NOT NULL,
  "credentials" text NOT NULL,
  "account_ref" text NOT NULL,
  "webhook_secret" text,
  "is_active" boolean DEFAULT false NOT NULL,
  "last_verified_at" timestamp with time zone,
  "last_polled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "courier_connections_tenant_id_courier_account_ref_unique"
    UNIQUE ("tenant_id", "courier", "account_ref"),
  CONSTRAINT "courier_connections_courier_check"
    CHECK ("courier" IN ('aramex', 'smsa', 'naqel', 'jt'))
);--> statement-breakpoint

ALTER TABLE "courier_connections"
  ADD CONSTRAINT "courier_connections_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "courier_connections_tenant_id_idx"
  ON "courier_connections" ("tenant_id");--> statement-breakpoint

-- The webhook routing key (D6 step 2): one ACTIVE connection per
-- (courier, account_ref) across the whole platform, so a callback resolves to
-- exactly one tenant and nothing in the body gets to choose.
CREATE UNIQUE INDEX IF NOT EXISTS "courier_connections_routing_key"
  ON "courier_connections" ("courier", "account_ref") WHERE "is_active";--> statement-breakpoint

ALTER TABLE "courier_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "courier_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "courier_connections_isolation" ON "courier_connections"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "shipments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "courier_connection_id" uuid NOT NULL,
  "courier" text NOT NULL,
  "tracking_number" text NOT NULL,
  "current_status" text DEFAULT 'label_created' NOT NULL,
  "current_status_at" timestamp with time zone,
  "estimated_delivery_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "last_notified_status" text,
  "last_notified_at" timestamp with time zone,
  "last_polled_at" timestamp with time zone,
  "poll_failure_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shipments_tenant_id_courier_tracking_number_unique"
    UNIQUE ("tenant_id", "courier", "tracking_number"),
  CONSTRAINT "shipments_courier_check"
    CHECK ("courier" IN ('aramex', 'smsa', 'naqel', 'jt')),
  CONSTRAINT "shipments_current_status_check"
    CHECK ("current_status" IN (
      'label_created', 'picked_up', 'in_transit', 'out_for_delivery',
      'delivered', 'failed_attempt', 'returned', 'cancelled', 'exception',
      'unknown'))
);--> statement-breakpoint

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- F25 owns `orders`; F26 only references it. This is the FK D3 requires and
-- the reason 0060 must run after 0059.
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_courier_connection_id_courier_connections_id_fk"
  FOREIGN KEY ("courier_connection_id") REFERENCES "public"."courier_connections"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipments_order_idx"
  ON "shipments" ("tenant_id", "order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_customer_idx"
  ON "shipments" ("tenant_id", "customer_id");--> statement-breakpoint
-- Every FK gets an index (F24 shipped one without and paid for it).
CREATE INDEX IF NOT EXISTS "shipments_connection_idx"
  ON "shipments" ("courier_connection_id");--> statement-breakpoint

-- The poll sweep's only query. Partial, so terminal shipments cost nothing
-- and can never be selected for polling however the code drifts (D5).
CREATE INDEX IF NOT EXISTS "shipments_poll_idx"
  ON "shipments" ("last_polled_at")
  WHERE "current_status" NOT IN ('delivered', 'returned', 'cancelled');--> statement-breakpoint

ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shipments_isolation" ON "shipments"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "shipment_status_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "shipment_id" uuid NOT NULL,
  "status" text NOT NULL,
  "raw_status" text NOT NULL,
  "location" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shipment_status_events_shipment_id_raw_status_occurred_at_unique"
    UNIQUE ("shipment_id", "raw_status", "occurred_at"),
  CONSTRAINT "shipment_status_events_source_check"
    CHECK ("source" IN ('poll', 'webhook', 'manual'))
);--> statement-breakpoint

ALTER TABLE "shipment_status_events"
  ADD CONSTRAINT "shipment_status_events_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "shipment_status_events"
  ADD CONSTRAINT "shipment_status_events_shipment_id_shipments_id_fk"
  FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipment_status_events_shipment_idx"
  ON "shipment_status_events" ("tenant_id", "shipment_id", "occurred_at" DESC);--> statement-breakpoint

ALTER TABLE "shipment_status_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment_status_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shipment_status_events_isolation" ON "shipment_status_events"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "shipment_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "shipment_id" uuid NOT NULL,
  "status" text NOT NULL,
  "template_id" uuid,
  "message_id" uuid,
  "outcome" text DEFAULT 'claimed' NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The insert IS the lock. Two concurrent pollers, or a poll racing a
  -- webhook, cannot both send a billed template for the same transition.
  CONSTRAINT "shipment_notifications_shipment_id_status_unique"
    UNIQUE ("shipment_id", "status"),
  CONSTRAINT "shipment_notifications_outcome_check"
    CHECK ("outcome" IN ('claimed', 'sent', 'failed', 'skipped_opt_out',
                         'skipped_no_template', 'skipped_disabled'))
);--> statement-breakpoint

ALTER TABLE "shipment_notifications"
  ADD CONSTRAINT "shipment_notifications_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "shipment_notifications"
  ADD CONSTRAINT "shipment_notifications_shipment_id_shipments_id_fk"
  FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "shipment_notifications"
  ADD CONSTRAINT "shipment_notifications_template_id_message_templates_id_fk"
  FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipment_notifications_shipment_idx"
  ON "shipment_notifications" ("tenant_id", "shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_notifications_template_idx"
  ON "shipment_notifications" ("template_id");--> statement-breakpoint

ALTER TABLE "shipment_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment_notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "shipment_notifications_isolation" ON "shipment_notifications"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "delivery_notification_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  -- Opt-IN, not opt-out. These are billed, business-initiated messages.
  "enabled" boolean DEFAULT false NOT NULL,
  "status_templates" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "delivery_notification_settings"
  ADD CONSTRAINT "delivery_notification_settings_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "delivery_notification_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_notification_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "delivery_notification_settings_isolation" ON "delivery_notification_settings"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- No RLS, deliberately (D7): this table is written before a tenant is known,
-- the same documented carve-out as `store_webhook_events`.
CREATE TABLE IF NOT EXISTS "courier_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "courier" text NOT NULL,
  "account_ref" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "courier_webhook_events_courier_account_ref_event_id_unique"
    UNIQUE ("courier", "account_ref", "event_id"),
  CONSTRAINT "courier_webhook_events_status_check"
    CHECK ("status" IN ('received', 'processed', 'failed', 'ignored'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "courier_webhook_events_courier_account_idx"
  ON "courier_webhook_events" ("courier", "account_ref");--> statement-breakpoint

-- D4: backfill the `track_order` tenant_tools row for every EXISTING tenant.
-- New tenants get it from CourierToolSeederService at signup; without this
-- backfill the tool would be unreachable for every tenant that already exists
-- — exactly F20's bug, which is why the backfill is part of this migration
-- rather than a follow-up.
--
-- tenant_tools is FORCE RLS and migrations run as app_user with no tenant GUC
-- set, so each row is written THROUGH the policy by setting app.tenant_id
-- transaction-locally, the same technique 0053 uses.
--
-- Canonical definition of both strings is `track-order.tool.ts`; this is a
-- copy, and re-running the app-side seeder is what refreshes it after a
-- change there.
DO $$
DECLARE
  tenant_row record;
BEGIN
  FOR tenant_row IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant_row."id"::text, true);

    INSERT INTO "tenant_tools" ("tenant_id", "name", "description", "json_schema", "enabled")
    VALUES (
      tenant_row."id",
      'track_order',
      'Look up the delivery status of the asking customer''s own shipments. Use when the customer asks where their order is, when it will arrive, or about a tracking number they quote. Pass the order reference or the courier tracking number the customer gave you — at least one is required, and there is deliberately no way to ask about another person''s order. Report only the status, location and estimated delivery date this tool returns: never estimate or promise a delivery date that is not in the result, never turn a status into a stronger claim than it makes, and if the tool returns no shipments, say you could not find one and escalate to the team rather than guessing.',
      '{"type":"object","properties":{"orderReference":{"type":"string","minLength":1,"maxLength":64,"description":"The order reference the customer quoted, e.g. \"#1234\""},"trackingNumber":{"type":"string","minLength":4,"maxLength":64,"description":"The courier tracking number / AWB the customer quoted"}},"anyOf":[{"required":["orderReference"]},{"required":["trackingNumber"]}],"additionalProperties":false}'::jsonb,
      true
    )
    ON CONFLICT ("tenant_id", "name") DO UPDATE
      SET "description" = excluded."description",
          "json_schema" = excluded."json_schema",
          "enabled" = true,
          "updated_at" = now();
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END $$;
