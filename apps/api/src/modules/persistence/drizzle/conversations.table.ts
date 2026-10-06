// Feature 4 (A7/D7): "Postgres is the only source of truth (conversations,
// messages, ...)." One row per (tenant, customer phone) — replaces T10's
// synthetic `${tenantId}:${from}` key (Feature 3) with a real entity now
// that this table exists; ConversationLockService/BurstCoalescingService
// keep using the synthetic key form (unaffected by this table's existence)
// since they only need a stable string, not a foreign key.
//
// `lastInboundAt` is D7's WA 24h-window basis ("derived from
// last_inbound_at, evaluated at send time — a run can cross the boundary
// mid-flight") — updated on every inbound message, read at send time by
// whatever eventually implements the window check (T3/WhatsappModule,
// not this table's concern).
//
// `rollingSummary`/`summarizedThroughMessageCount` are D7's "working
// memory per turn = rolling summary + last 10 messages; summarization
// runs async after reply, never on the respond path" — this table stores
// the summary's current state; SummarizationService (Feature 4) is what
// updates it, off the respond path.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import type { ChannelKind } from '../../channel/ports/channel-kind';

/**
 * Who is answering this conversation right now.
 *
 * 'agent' — the normal state; the respond path runs a turn per inbound
 * message. 'human' — a person on the tenant's team has taken over, and the
 * agent must stay silent: without this, a customer replying to a human gets
 * the agent's answer first, because the webhook fires either way.
 */
export const HANDOVER_STATES = ['agent', 'human'] as const;
export type HandoverState = (typeof HANDOVER_STATES)[number];

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /**
     * Feature 16: which channel this thread lives on. Part of the identity
     * key, not a display attribute — a Messenger PSID and a WhatsApp number
     * are both digit strings, and without this column a PSID that happened
     * to collide with a phone number would silently merge two different
     * people's conversations into one row.
     *
     * Defaults to 'whatsapp' so every row written before Feature 16 is
     * correctly labelled by the migration rather than backfilled by a guess.
     */
    channel: text('channel').notNull().default('whatsapp').$type<ChannelKind>(),
    /** The customer's channel-scoped identity: a WhatsApp id, a Messenger PSID, or an Instagram IGSID. Column name predates Feature 16; it is NOT always a phone number. */
    customerPhone: text('customer_phone').notNull(),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * The channel ACCOUNT this conversation arrived on — a WhatsApp
     * `phone_number_id`, a Facebook page id, or an Instagram account id
     * (Feature 16). The column name predates the other two.
     *
     * Needed to reply: a send has to go out from the same number the
     * customer has been talking to, and a tenant with two numbers has no
     * single right answer without this. Nullable because conversations
     * created before this column existed have no record of it — those fall
     * back to the tenant's number when it is unambiguous.
     */
    phoneNumberId: text('phone_number_id'),
    /** See HANDOVER_STATES. Checked at the top of the respond path. */
    handoverState: text('handover_state').notNull().default('agent'),
    /** When the current handover started — the basis for the auto-return timeout, so a conversation a human forgot about does not stay silent forever. Null while handoverState is 'agent'. */
    handoverAt: timestamp('handover_at', { withTimezone: true }),
    /** Who took it over. Null while handoverState is 'agent'. Not an FK, same reason as messages.authorUserId. */
    handoverUserId: uuid('handover_user_id'),
    /** When the single "a team member will reply shortly" holding reply of the CURRENT handover was sent to the customer. Null until sent; cleared by startHandover/returnToAgent so every new handover gets its own one reply. */
    handoverHoldingReplyAt: timestamp('handover_holding_reply_at', {
      withTimezone: true,
    }),
    rollingSummary: text('rolling_summary'),
    /** How many messages have been folded into rollingSummary so far — SummarizationService's own bookkeeping for "is there enough new history to re-summarize yet." */
    summarizedThroughMessageCount: integer('summarized_through_message_count')
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Feature 16 widened this from (tenant, phone): see `channel` above. The
  // constraint NAME is pinned to the pre-Feature-16 auto-generated one so
  // `onConflictDoUpdate` targets keep resolving and the migration is an
  // in-place redefinition rather than a drop-and-rename dance.
  (table) => [
    unique('conversations_tenant_id_customer_phone_unique').on(
      table.tenantId,
      table.channel,
      table.customerPhone,
    ),
  ],
).enableRLS();
