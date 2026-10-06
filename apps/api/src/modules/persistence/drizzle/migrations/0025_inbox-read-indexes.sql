-- Inbox read path (console conversation list + transcript view). Both
-- listings are keyset-paginated over a (timestamp, id) tuple, and neither
-- table had a single index before this migration — every page was a
-- sequential scan plus a sort over the tenant's whole history.
--
-- Column order matches the queries exactly:
--   * conversations: filtered by tenant (RLS adds `tenant_id = ...` to
--     every query), ordered by `last_inbound_at DESC, id DESC`.
--   * messages: filtered by `conversation_id`, ordered by
--     `created_at DESC, id DESC` — and the same index serves the agent's
--     own `getRecentWindow()`/`getMessagesAfter()` reads, which have been
--     scanning too.
--
-- Written by hand rather than generated: drizzle-kit's snapshots stop at
-- 0021 (see 0022-0024), and index definitions are deliberately kept out of
-- the `*.table.ts` files so a future `db:generate` cannot drop them.
CREATE INDEX IF NOT EXISTS "conversations_tenant_last_inbound_idx"
  ON "conversations" ("tenant_id", "last_inbound_at" DESC, "id" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx"
  ON "messages" ("conversation_id", "created_at" DESC, "id" DESC);--> statement-breakpoint

-- The `escalated` filter is an EXISTS over tickets by conversation, and the
-- kanban list already joins tickets → customers per conversation.
CREATE INDEX IF NOT EXISTS "tickets_conversation_idx"
  ON "tickets" ("conversation_id");
