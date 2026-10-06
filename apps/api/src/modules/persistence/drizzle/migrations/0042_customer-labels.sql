-- Feature 18 (Intent Labeling): `customer_labels` — the Hot/Warm/Cold label
-- derived from A5's existing per-turn escalation/confidence decision (D10) and
-- attached to a T13 `customers` row.
--
-- One row per (tenant, customer): a label is a property of the customer, not of
-- a turn. `agent_runs` (A8) already holds the per-turn record this is derived
-- from, so no history is duplicated here.
--
-- `overridden_at`/`overridden_by` are the override-wins precedence marker. The
-- rule is enforced by the writer's `ON CONFLICT ... WHERE overridden_at IS NULL`
-- clause rather than a trigger, so it is visible at the call site that is
-- subject to it (CustomerLabelService.applyAgentSignal).
--
-- `overridden_by` is not a foreign key, for the same reason as
-- `messages.author_user_id`: users live in Supabase Auth, not in this database.

CREATE TABLE IF NOT EXISTS "customer_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "label" text NOT NULL,
  "overridden_at" timestamp with time zone,
  "overridden_by" uuid,
  "agent_evaluated_at" timestamp with time zone,
  "agent_label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_labels_tenant_id_customer_id_unique" UNIQUE ("tenant_id", "customer_id")
);--> statement-breakpoint

ALTER TABLE "customer_labels"
  ADD CONSTRAINT "customer_labels_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The customer FK is COMPOSITE, on purpose. A per-column FK to `customers.id`
-- would let a caller write a label row under THEIR tenant pointing at another
-- tenant's customer id — RLS' WITH CHECK only constrains `tenant_id`, and the
-- FK would be satisfied because that customer really does exist. Nothing leaks
-- (they still cannot read the victim's rows), but the row would be junk and
-- Feature 19's segments would be built on it. Needs a unique key on
-- (tenant_id, id) to reference; `customers.id` is already the primary key, so
-- this constraint is redundant for uniqueness and exists purely as the FK
-- target.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_tenant_id_id_unique" UNIQUE ("tenant_id", "id");--> statement-breakpoint

ALTER TABLE "customer_labels"
  ADD CONSTRAINT "customer_labels_tenant_id_customer_id_customers_fk"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "public"."customers"("tenant_id", "id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Feature 19's segment builder filters by (tenant, label). The unique
-- constraint above already covers the (tenant, customer) lookup the kanban
-- list and customer detail do.
CREATE INDEX IF NOT EXISTS "customer_labels_tenant_label_idx"
  ON "customer_labels" ("tenant_id", "label");
