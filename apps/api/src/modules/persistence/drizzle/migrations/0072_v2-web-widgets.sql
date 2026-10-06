-- Clarly 2.0 S3 (docs/v2/FEATURE_MATRIX.md, "Channels"): the website chat
-- widget, ported from Autologic's widget.js and rebuilt as a Clarly channel
-- (`web`) that goes through the same ingest and respond path as WhatsApp.
--
-- One row per widget. NOT RLS-scoped, deliberately, for the same reason as
-- `whatsapp_numbers` (0004): an anonymous visitor's request names a public
-- key, and resolving it to a tenant has to happen before any tenant context
-- exists. Nothing secret lives here — the public key is printed on the
-- tenant's own website by design — and every tenant-facing read and write
-- filters on tenant_id explicitly (asserted by the service spec).

CREATE TABLE IF NOT EXISTS "web_widgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "public_key" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "allowed_origins" text[] NOT NULL DEFAULT '{}',
  "title" text,
  "welcome_message" text,
  "accent_color" text NOT NULL DEFAULT '#16181D',
  "position" text NOT NULL DEFAULT 'right',
  "locale" text NOT NULL DEFAULT 'auto',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "web_widgets_public_key_unique" UNIQUE ("public_key"),
  CONSTRAINT "web_widgets_tenant_unique" UNIQUE ("tenant_id"),
  CONSTRAINT "web_widgets_accent_check" CHECK ("accent_color" ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT "web_widgets_position_check" CHECK ("position" IN ('right', 'left')),
  CONSTRAINT "web_widgets_locale_check" CHECK ("locale" IN ('auto', 'ar', 'en')),
  CONSTRAINT "web_widgets_origins_check" CHECK (cardinality("allowed_origins") <= 20)
);
