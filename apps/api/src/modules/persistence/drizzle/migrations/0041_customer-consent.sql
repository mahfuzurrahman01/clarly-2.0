-- Per-customer messaging consent.
--
-- A customer who says STOP must stop hearing from us. WhatsApp requires it,
-- and there was nowhere in this schema to even record that they asked.
--
-- Lives on `customers` rather than a new table because that is already exactly
-- one row per (tenant, phone) — the grain consent is expressed at. A separate
-- table would have the same key and the same lifetime.
--
-- Two columns, not one: `opted_out_at` is the fact, `opt_out_source` is how it
-- happened. A compliance question is never just "did they opt out", it is
-- "how do you know" — a keyword the customer typed and an admin toggling a
-- switch are very different answers.

ALTER TABLE "customers"
  ADD COLUMN "opted_out_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "customers"
  ADD COLUMN "opt_out_source" text;
