// Product shell (ConversationModule, A7/D7): "Postgres is the only source
// of truth (conversations, messages, ...)." This service owns the actual
// read/write path — get-or-create, appending inbound/outbound messages,
// and D7's "working memory per turn = rolling summary + last 10 messages"
// recent-window query. Summarization itself (writing rollingSummary) is
// SummarizationService's job, not this file's — this only exposes
// updateSummary() as the write primitive it calls.
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import {
  conversations,
  messages,
  type MessageDeliveryStatus,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  DEFAULT_CHANNEL,
  type ChannelKind,
} from '../channel/ports/channel-kind';
import type {
  ConversationRecord,
  InboundMessageToRecord,
  RecentMessage,
} from './conversation.dto';

/** D7: "last 10 messages." */
const RECENT_WINDOW_SIZE = 10;

@Injectable()
export class ConversationService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * One row per (tenant, channel, customer identity) — idempotent, race-safe
   * (onConflictDoUpdate touches updatedAt rather than requiring a separate
   * select-then-insert).
   *
   * Feature 16 added `channel` to that key. It defaults to 'whatsapp' so
   * every existing caller keeps its exact behaviour; the point of having it
   * in the key at all is that a Messenger PSID and a WhatsApp number are
   * both digit strings, and a collision must not merge two different
   * people's threads.
   */
  async getOrCreateConversation(
    tenantId: string,
    customerPhone: string,
    /** The channel ACCOUNT this message arrived on — stored so a human reply goes back out the same one. */
    channelAccountId?: string,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<ConversationRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(conversations)
          .values({
            tenantId,
            channel,
            customerPhone,
            phoneNumberId: channelAccountId,
          })
          .onConflictDoUpdate({
            target: [
              conversations.tenantId,
              conversations.channel,
              conversations.customerPhone,
            ],
            set: {
              updatedAt: new Date(),
              // Refreshed rather than written once: a tenant can move a
              // customer's thread to a different account, and replying to the
              // one they last wrote to is what a customer expects.
              ...(channelAccountId ? { phoneNumberId: channelAccountId } : {}),
            },
          })
          .returning(),
      tenantId,
    );

    return toRecord(row);
  }

  /** One `messages` row per original bspMessageId, even when they arrived as one T10-coalesced batch — the transcript stays message-accurate. Also bumps `lastInboundAt` (D7's WA-window basis) to `receivedAt`. */
  async recordInboundMessages(
    tenantId: string,
    conversationId: string,
    inboundMessages: InboundMessageToRecord[],
    receivedAt: Date,
  ): Promise<void> {
    if (inboundMessages.length === 0) return;

    await this.tenantContext.withTenantTx(async (tx) => {
      await tx.insert(messages).values(
        inboundMessages.map((message, index) => ({
          tenantId,
          conversationId,
          role: 'user' as const,
          content: message.text,
          bspMessageId: message.providerMessageId,
          // createdAt is set EXPLICITLY, one millisecond apart per message
          // in batch order, instead of leaning on the column's defaultNow().
          // `now()` is the TRANSACTION's start time, so every row of a
          // T10-coalesced batch would otherwise carry the byte-identical
          // timestamp — and getRecentWindow()/getMessagesAfter() order by
          // exactly that column. Ties there are resolved by Postgres in
          // whatever order the plan happens to emit rows (no stable
          // tiebreaker exists on this table), so a burst of "wrong item" /
          // "I meant the blue one" could be replayed to the model in either
          // order, and getRecentWindow()'s LIMIT could slice a tie group in
          // half. The offsets are sub-perceptible, and they make the stored
          // transcript order match the order the customer actually sent —
          // which is the order the agent already reasons over, since the
          // batch is joined in this same sequence to form `currentMessage`.
          //
          // Offsets run BACKWARDS from the transaction's `now()` (the last
          // message lands exactly on it) rather than forwards, so the whole
          // batch is strictly at-or-before it. Forward offsets could push a
          // large batch's tail past the assistant reply that this same turn
          // writes a moment later, inverting the turn itself. Backwards is
          // also the honest direction: a coalesced batch really did arrive
          // over the debounce window leading up to now.
          //
          // The base is the DATABASE clock (`now()`), not `receivedAt`'s app
          // clock, on purpose. `recordAssistantMessage()` a moment later
          // still uses the column default (`now()`), so mixing clocks here
          // would make the user/assistant ordering depend on app-vs-database
          // clock skew — invisible on a single-host dev box, a real
          // transcript inversion against a managed database. `receivedAt`
          // remains the app-clock value for `last_inbound_at` below, which
          // is a WA-window deadline (D7), not an ordering key.
          createdAt: sql`now() - make_interval(secs => ${(inboundMessages.length - 1 - index) / 1000})`,
        })),
      );

      await tx
        .update(conversations)
        .set({ lastInboundAt: receivedAt, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.tenantId, tenantId),
          ),
        );
    }, tenantId);
  }

  /** Returns the new row's id so the caller can attach the BSP's message id once the send comes back — without it, a later delivery callback has nothing to match on. */
  async recordAssistantMessage(
    tenantId: string,
    conversationId: string,
    content: string,
  ): Promise<string> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(messages)
          .values({
            tenantId,
            conversationId,
            role: 'assistant',
            content,
          })
          .returning({ id: messages.id }),
      tenantId,
    );
    return row.id;
  }

  /**
   * Records the id the BSP assigned an outbound message, plus the initial
   * 'sent' status. Called after a successful send: the row is written before
   * delivery is attempted (so a crash mid-send still leaves the transcript
   * honest about what the agent said), and learns its id here.
   */
  async attachOutboundDelivery(
    tenantId: string,
    messageId: string,
    bspMessageId: string,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messages)
          .set({
            bspMessageId,
            deliveryStatus: 'sent',
            deliveryUpdatedAt: new Date(),
          })
          .where(
            and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)),
          ),
      tenantId,
    );
  }

  /**
   * Applies a BSP status callback to whichever outbound row carries that
   * `bspMessageId`. A callback for an id we never stored updates nothing and
   * is not an error — Meta re-sends statuses for messages older than our
   * retention window, and for messages sent outside this system entirely.
   *
   * Statuses are NOT ordered on the wire: 'delivered' can arrive after
   * 'read'. The rank guard below keeps the row at the furthest state it has
   * ever reached, so a late-arriving earlier status cannot walk it backwards.
   * 'failed' is terminal in the other direction — it always wins, because a
   * human needs to know the message did not arrive.
   */
  async applyDeliveryStatus(
    tenantId: string,
    bspMessageId: string,
    status: MessageDeliveryStatus,
    error: string | null,
  ): Promise<boolean> {
    const updated = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messages)
          .set({
            deliveryStatus: status,
            deliveryError: error,
            deliveryUpdatedAt: new Date(),
          })
          .where(
            and(
              eq(messages.bspMessageId, bspMessageId),
              eq(messages.tenantId, tenantId),
              status === 'failed'
                ? undefined
                : sql`coalesce(${messages.deliveryStatus}, '') not in ('failed', ${sql.raw(
                    laterStatuses(status)
                      .map((value) => `'${value}'`)
                      .join(', ') || `''`,
                  )})`,
            ),
          )
          .returning({ id: messages.id }),
      tenantId,
    );
    return updated.length > 0;
  }

  /** A person on the team replying. Role 'human_agent', never 'assistant' — see messages.table.ts for why that distinction is load-bearing. */
  async recordHumanAgentMessage(input: {
    tenantId: string;
    conversationId: string;
    content: string;
    /** Null for a message a person authored through an automation they launched but is not sitting on — F19's campaign sender, where `campaigns.created_by` may predate user tracking. The column has always been nullable. */
    authorUserId: string | null;
    clientMessageId: string;
  }): Promise<string> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(messages)
          .values({
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            role: 'human_agent',
            content: input.content,
            authorUserId: input.authorUserId,
            clientMessageId: input.clientMessageId,
          })
          .returning({ id: messages.id }),
      input.tenantId,
    );
    return row.id;
  }

  /**
   * F26 (D5): an automated, business-initiated template the PLATFORM sent —
   * a shipment status update, not a person and not an agent turn.
   *
   * Role 'assistant' with no author, deliberately: nobody on the team pressed
   * send, and the conversation must stay with the agent afterwards (the
   * caller does NOT start handover). `clientMessageId` is deterministic
   * (`shipment:<id>:<status>`), so the existing `findByClientMessageId`
   * idempotency is a second barrier behind F26's notification claim row.
   */
  async recordSystemTemplateMessage(input: {
    tenantId: string;
    conversationId: string;
    content: string;
    clientMessageId: string;
  }): Promise<string> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(messages)
          .values({
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            role: 'assistant',
            content: input.content,
            authorUserId: null,
            clientMessageId: input.clientMessageId,
          })
          .returning({ id: messages.id }),
      input.tenantId,
    );
    return row.id;
  }

  /**
   * Gulf T3 (D13): a message the business sent from the WhatsApp Business
   * app on a coexistence number. A human reply in every sense that matters —
   * role 'human_agent', so prompt assembly never replays it as the agent's
   * own words — with no author (nobody on the team is signed in to the
   * phone app) and already 'sent', because Meta only echoes what it sent.
   */
  async recordBusinessAppEcho(input: {
    tenantId: string;
    conversationId: string;
    providerMessageId: string;
    content: string;
    sentAt: Date;
  }): Promise<string> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(messages)
          .values({
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            role: 'human_agent',
            content: input.content,
            bspMessageId: input.providerMessageId,
            deliveryStatus: 'sent',
            deliveryUpdatedAt: input.sentAt,
            createdAt: input.sentAt,
          })
          .returning({ id: messages.id }),
      input.tenantId,
    );
    return row.id;
  }

  /**
   * Records an inbound message that carried an attachment (F13).
   *
   * Separate from `recordInboundMessages` because that path is the agent's:
   * it batches a T10 burst and its rows go on to be answered. This one row is
   * never answered — the conversation escalates — but it must still exist,
   * because until now a non-text message produced no row at all and the
   * transcript simply omitted it. "The customer sent something and we cannot
   * show you what" is a bad answer; showing nothing at all is a wrong one.
   *
   * `content` is the customer's caption when they typed one, and a plain
   * marker otherwise. It is what prompt assembly and the rolling summary will
   * read, so it says what happened in words rather than being left empty.
   */
  async recordInboundMediaMessage(input: {
    tenantId: string;
    conversationId: string;
    /** The provider's own message id — `wamid.*` on WhatsApp, `mid.*` on Messenger/Instagram (Feature 16). Stored in the `bsp_message_id` column, whose name predates the other two channels. */
    providerMessageId: string;
    content: string;
    mediaId: string;
    mimeType: string | null;
    filename: string | null;
    receivedAt: Date;
  }): Promise<string> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(messages)
          .values({
            tenantId: input.tenantId,
            conversationId: input.conversationId,
            role: 'user',
            content: input.content,
            bspMessageId: input.providerMessageId,
            mediaId: input.mediaId,
            // 'pending', not null: the bytes are on their way, and a human
            // opening the ticket in the next second needs to be told that
            // rather than shown an attachment-less message.
            mediaStatus: 'pending',
            mediaMimeType: input.mimeType,
            mediaFilename: input.filename,
            createdAt: input.receivedAt,
          })
          .returning({ id: messages.id }),
      input.tenantId,
    );
    return row.id;
  }

  /** The bytes landed. */
  async markMediaStored(
    tenantId: string,
    messageId: string,
    stored: { storageKey: string; sizeBytes: number; mimeType: string | null },
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messages)
          .set({
            mediaStatus: 'stored',
            mediaStorageKey: stored.storageKey,
            mediaSizeBytes: stored.sizeBytes,
            // The BSP's content type from the fetch wins over the webhook's,
            // when it gave one: the fetch is the response that actually
            // carried the bytes.
            ...(stored.mimeType ? { mediaMimeType: stored.mimeType } : {}),
            mediaError: null,
          })
          .where(
            and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)),
          ),
      tenantId,
    );
  }

  /** The bytes are not coming. Recorded on the row so a human is told why rather than shown a spinner forever. */
  async markMediaFailed(
    tenantId: string,
    messageId: string,
    status: 'failed' | 'too_large',
    error: string,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messages)
          .set({ mediaStatus: status, mediaError: error })
          .where(
            and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)),
          ),
      tenantId,
    );
  }

  /**
   * F17 follow-up: persists a voice note's ASR transcript once the agent
   * turn that computed it finishes. One row per item, but each write is
   * independent (a single bad `messageId` — should never happen, `TurnMedia`
   * is built from the same rows this updates — must not lose the rest of a
   * multi-attachment burst).
   */
  async saveMediaTranscripts(
    tenantId: string,
    transcripts: { messageId: string; text: string }[],
  ): Promise<void> {
    if (transcripts.length === 0) return;
    await this.tenantContext.withTenantTx(async (tx) => {
      for (const { messageId, text } of transcripts) {
        await tx
          .update(messages)
          .set({ mediaTranscript: text })
          .where(
            and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)),
          );
      }
    }, tenantId);
  }

  /** What the read path needs to serve an attachment: the key, and enough to name and type the response. */
  async findMediaMessage(
    tenantId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{
    storageKey: string;
    mimeType: string | null;
    filename: string | null;
    status: string | null;
  } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            storageKey: messages.mediaStorageKey,
            mimeType: messages.mediaMimeType,
            filename: messages.mediaFilename,
            status: messages.mediaStatus,
          })
          .from(messages)
          .where(
            and(
              eq(messages.id, messageId),
              eq(messages.conversationId, conversationId),
              eq(messages.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );

    const row = rows[0];
    // A row with no storage key is not servable, whatever its status says —
    // the caller gets the same "nothing to download here" either way.
    if (!row?.storageKey) return null;
    return { ...row, storageKey: row.storageKey };
  }

  /** The double-send guard's read half: an id already used means the send already happened. */
  async findByClientMessageId(
    tenantId: string,
    clientMessageId: string,
  ): Promise<{
    id: string;
    content: string;
    deliveryStatus: string | null;
    deliveryError: string | null;
  } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: messages.id,
            // Returned so an idempotent replay can echo back what was
            // actually sent — a rendered template, not its raw `{{1}}` body.
            content: messages.content,
            deliveryStatus: messages.deliveryStatus,
            deliveryError: messages.deliveryError,
          })
          .from(messages)
          .where(
            and(
              eq(messages.clientMessageId, clientMessageId),
              eq(messages.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ?? null;
  }

  /** Marks an outbound message as not delivered, with the BSP's own words — a human needs to know why, not just that. */
  async markOutboundFailed(
    tenantId: string,
    messageId: string,
    error: string,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(messages)
          .set({
            deliveryStatus: 'failed',
            deliveryError: error,
            deliveryUpdatedAt: new Date(),
          })
          .where(
            and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)),
          ),
      tenantId,
    );
  }

  /** Puts the conversation in human hands: the respond path stops answering until it is returned. */
  async startHandover(
    tenantId: string,
    conversationId: string,
    /** Null when the human is not a console user: a WhatsApp Business app reply on a coexistence number (Gulf T3, D13). */
    userId: string | null,
    at: Date,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(conversations)
          .set({
            handoverState: 'human',
            handoverAt: at,
            handoverUserId: userId,
            handoverHoldingReplyAt: null,
            updatedAt: at,
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  /** Hands the conversation back to the agent — explicitly by a human, or automatically once a handover goes stale (see RespondPathProcessor). */
  async returnToAgent(
    tenantId: string,
    conversationId: string,
    at: Date,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(conversations)
          .set({
            handoverState: 'agent',
            handoverAt: null,
            handoverUserId: null,
            handoverHoldingReplyAt: null,
            updatedAt: at,
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  /** Records that this handover's one holding reply went out, so no second one is sent until the next handover resets it. */
  async markHandoverHoldingReplySent(
    tenantId: string,
    conversationId: string,
    at: Date,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(conversations)
          .set({ handoverHoldingReplyAt: at })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  /** True when a person on the team has replied in this conversation at or after `since` (the handover start). */
  async hasHumanReplySince(
    tenantId: string,
    conversationId: string,
    since: Date,
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.tenantId, tenantId),
              eq(messages.role, 'human_agent'),
              gte(messages.createdAt, since),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows.length > 0;
  }

  /** D7's recent-window half of working memory — oldest first, ready to feed straight into PromptAssemblyInput.recentMessages. */
  async getRecentWindow(
    tenantId: string,
    conversationId: string,
    limit: number = RECENT_WINDOW_SIZE,
  ): Promise<RecentMessage[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.tenantId, tenantId),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(limit),
      tenantId,
    );

    return rows.reverse().map((row) => ({
      role: row.role as RecentMessage['role'],
      content: row.content,
    }));
  }

  /** SummarizationService's read path — messages strictly after `afterCount` (oldest-first), i.e. only what's new since the last summarization. Keeps the summarization LLM call's input bounded to "prior summary + the delta," never the whole transcript, regardless of how long the conversation gets. */
  async getMessagesAfter(
    tenantId: string,
    conversationId: string,
    afterCount: number,
  ): Promise<RecentMessage[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.tenantId, tenantId),
            ),
          )
          .orderBy(messages.createdAt)
          .offset(afterCount),
      tenantId,
    );

    return rows.map((row) => ({
      role: row.role as RecentMessage['role'],
      content: row.content,
    }));
  }

  /** Total message count for this conversation — SummarizationService uses this against `summarizedThroughMessageCount` to decide whether there's enough new history to re-summarize. */
  async getMessageCount(
    tenantId: string,
    conversationId: string,
  ): Promise<number> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ count: count() })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
    return row?.count ?? 0;
  }

  async updateSummary(
    tenantId: string,
    conversationId: string,
    summary: string,
    summarizedThroughMessageCount: number,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(conversations)
          .set({
            rollingSummary: summary,
            summarizedThroughMessageCount,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  async getConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

/** Statuses strictly further along the lifecycle than `status` — the set that must not be overwritten by a late-arriving `status`. */
function laterStatuses(status: MessageDeliveryStatus): string[] {
  const order: MessageDeliveryStatus[] = ['sent', 'delivered', 'read'];
  const index = order.indexOf(status);
  return index === -1 ? [] : order.slice(index + 1);
}

function toRecord(row: typeof conversations.$inferSelect): ConversationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    channel: row.channel,
    customerPhone: row.customerPhone,
    channelAccountId: row.phoneNumberId,
    lastInboundAt: row.lastInboundAt,
    handoverState: row.handoverState as ConversationRecord['handoverState'],
    handoverAt: row.handoverAt,
    handoverUserId: row.handoverUserId,
    handoverHoldingReplyAt: row.handoverHoldingReplyAt,
    rollingSummary: row.rollingSummary,
    summarizedThroughMessageCount: row.summarizedThroughMessageCount,
  };
}
