-- SAAS_READINESS §2's last piece: replying to a customer from the console.
--
-- `conversations.phone_number_id` — a reply must go out from the number the
-- customer has been talking to, and a tenant with two numbers has no single
-- right answer without it. Nullable: conversations that predate this column
-- fall back to the tenant's number when that is unambiguous.
--
-- `messages.client_message_id` — the double-send guard. An agent hitting send
-- twice, or a retry after a flaky response, must not put the same message in
-- front of a customer twice. Unique per tenant; NULL for every machine-sent
-- row, and Postgres allows many NULLs in a unique index.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "phone_number_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "client_message_id" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "messages_tenant_client_message_id_idx"
  ON "messages" ("tenant_id", "client_message_id")
  WHERE "client_message_id" IS NOT NULL;
