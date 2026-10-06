// Feature 4 (A7/D7): the transcript itself — "Postgres is the only source
// of truth (conversations, messages, ...)." One row per turn-side: an
// inbound customer message (role 'user', bspMessageId set) or the agent's
// reply (role 'assistant', bspMessageId null — it never had one). T10's
// coalesced batch (Feature 3) still inserts one row per original
// bspMessageId here, even though the batch is treated as a single LLM
// turn — the transcript stays message-accurate; only prompt assembly
// (A3/A4) collapses a batch into one logical turn.
import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { conversations } from './conversations.table';

// 'human_agent' is a person on the tenant's team replying through the
// console, NOT the agent. It is a distinct role rather than an 'assistant'
// row with a flag because every consumer must treat it differently: prompt
// assembly labels it so the model never mistakes a human's promise for its
// own prior turn, and summarization records it as "a human intervened."
// Storing a human reply as 'assistant' would replay it to the LLM as
// something the agent itself said.
export const MESSAGE_ROLES = ['user', 'assistant', 'human_agent'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * Outbound delivery lifecycle, fed by the BSP's status callbacks. `null` on
 * inbound rows (a customer message has no delivery state of ours) and on
 * outbound rows whose send has not been acknowledged yet.
 *
 * 'failed' is the one that matters operationally: the existing
 * DELIVERY_FAILURE ticket only covers a send that threw synchronously, while
 * an async failure callback arrives minutes later and, until now, was parsed
 * to nothing at all.
 */
export const MESSAGE_DELIVERY_STATUSES = [
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];

/**
 * Lifecycle of an inbound attachment's bytes (F13).
 *
 * A status, not a nullable storage key, because the three failure shapes are
 * different things a human needs told apart: still arriving, gone for good,
 * and refused for being too big. A bare null would render all three as "no
 * attachment", which is the same blindness this feature exists to remove.
 */
export const MEDIA_STATUSES = [
  'pending',
  'stored',
  'failed',
  'too_large',
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  /**
   * Inbound: the id the BSP assigned the customer's message. Outbound: the
   * id the BSP returned from the send, attached after delivery — it is the
   * only key a later status callback can be matched on, so an outbound row
   * without it can never learn whether it arrived.
   */
  bspMessageId: text('bsp_message_id'),
  /**
   * Caller-supplied id for an outbound human reply, unique per tenant.
   *
   * This is the double-send guard. A support agent hitting send twice — or a
   * flaky connection retrying — must not put the same message in front of a
   * customer twice, and the console cannot prevent that on its own.
   */
  clientMessageId: text('client_message_id'),
  /** Which team member sent this, for role='human_agent' rows. Null for both machine roles — the agent has no user identity. Not an FK: users live in Supabase auth, outside this database's schema. */
  authorUserId: uuid('author_user_id'),
  /** See MESSAGE_DELIVERY_STATUSES. Null until the BSP says otherwise. */
  deliveryStatus: text('delivery_status'),
  /** The BSP's failure detail for deliveryStatus='failed' — kept verbatim so a human is told why, not just that. */
  deliveryError: text('delivery_error'),
  deliveryUpdatedAt: timestamp('delivery_updated_at', { withTimezone: true }),
  /**
   * The BSP's id for an inbound attachment. Kept after the fetch as the only
   * way to tell a re-download attempt from a first one, and because it is
   * what a support conversation with the BSP is conducted in.
   */
  mediaId: text('media_id'),
  /** See MEDIA_STATUSES. Null on every message that has no attachment at all. */
  mediaStatus: text('media_status').$type<MediaStatus>(),
  /** ObjectStorage key, set once the bytes land. Null while pending and on every failure. */
  mediaStorageKey: text('media_storage_key'),
  /** What the BSP said the bytes are. Advisory: it is attacker-influenced, so the read path serves media as a download rather than trusting this to be safe to render inline. */
  mediaMimeType: text('media_mime_type'),
  mediaSizeBytes: integer('media_size_bytes'),
  /** Original filename for documents. Metadata only — storage keys are never derived from it. */
  mediaFilename: text('media_filename'),
  /** Why the bytes are not here, in the BSP's own words. */
  mediaError: text('media_error'),
  /**
   * Feature 17's ASR transcript for a voice note, persisted from the agent
   * turn that computed it — the transcript otherwise lived only in-memory
   * inside a single LLM prompt and was gone once that turn finished. Null
   * for every non-voice attachment, and for a voice note whose turn has not
   * run yet (an escalated ticket with no agent turn) or whose transcription
   * failed. Never re-transcribed for display: this is the exact text the
   * agent reasoned from, not a fresh best-effort re-run.
   */
  mediaTranscript: text('media_transcript'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
