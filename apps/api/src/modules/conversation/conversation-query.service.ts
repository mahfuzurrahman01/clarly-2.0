// Product shell (ConversationModule): the console's read path over
// `conversations`/`messages`. Separate from `ConversationService`, which is
// the agent's write/working-memory path — same tables, opposite consumer,
// and no shared query shapes (the agent wants "last 10, oldest first," a
// human wants "all of it, paginated, newest first").
//
// Two rules hold everywhere below:
//   - Batched, never N+1. The list is a bounded number of queries
//     regardless of page size — the same discipline T8 imposed on the
//     kanban list.
//   - Keyset pagination. See inbox-cursor.ts for why OFFSET is wrong here.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  agents,
  agentVersions,
  answerFeedback,
  conversationIntake,
  customerAttributes,
  customerLabels,
  conversations,
  customers,
  messages,
  tickets,
  type HandoverState,
  type MessageDeliveryStatus,
  type MessageRole,
} from '../persistence/drizzle/schema';
import { ChannelPolicyRegistry } from '../channel/channel-policy.registry';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { encodeCursor, type InboxCursor } from './inbox-cursor';
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  ListConversationsFilters,
  Page,
} from './conversation-query.dto';

/** Raw row shape of the batched aggregate query below. */
interface MessageAggregateRow extends Record<string, unknown> {
  conversation_id: string;
  message_count: number;
  last_role: string | null;
  last_content: string | null;
  last_created_at: string | Date | null;
}

interface MessageAggregate {
  messageCount: number;
  lastMessage: ConversationSummary['lastMessage'];
}

@Injectable()
export class ConversationQueryService {
  constructor(
    private readonly tenantContext: TenantContextService,
    // Feature 16: the reply window is asked of the CHANNEL rather than
    // assumed to be WhatsApp's 24 hours. A lookup, not a branch.
    private readonly channelPolicies: ChannelPolicyRegistry,
  ) {}

  /**
   * Inbox list, newest activity first. Sorted by `last_inbound_at` rather
   * than `updated_at`: `updated_at` is also bumped by summarization, which
   * would let a background job reorder a human's inbox for no
   * customer-visible reason.
   */
  async listConversations(
    tenantId: string,
    filters: ListConversationsFilters,
    limit: number,
    cursor: InboxCursor | null,
  ): Promise<Page<ConversationSummary>> {
    const escalatedFilter =
      filters.escalated === undefined
        ? undefined
        : sql`${filters.escalated ? sql`` : sql`not `}exists (select 1 from ${tickets} where ${tickets.conversationId} = ${conversations.id})`;

    const conditions: Array<SQL | undefined> = [
      eq(conversations.tenantId, tenantId),
      filters.phone
        ? ilike(conversations.customerPhone, `%${filters.phone}%`)
        : undefined,
      filters.from ? gte(conversations.lastInboundAt, filters.from) : undefined,
      filters.to ? lte(conversations.lastInboundAt, filters.to) : undefined,
      escalatedFilter,
      // Row-value comparison, so the (timestamp, id) pair is compared as one
      // ordered tuple — the exact inverse of the ORDER BY below.
      cursor
        ? sql`(${conversations.lastInboundAt}, ${conversations.id}) < (${cursor.at}, ${cursor.id}::uuid)`
        : undefined,
    ];

    // One extra row is fetched to answer "is there another page" without a
    // second count query; it is sliced off before returning.
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: conversations.id,
            channel: conversations.channel,
            customerPhone: conversations.customerPhone,
            lastInboundAt: conversations.lastInboundAt,
            customerName: customers.name,
            label: customerLabels.label,
          })
          .from(conversations)
          .leftJoin(
            customers,
            and(
              eq(customers.tenantId, conversations.tenantId),
              // Feature 16: the channel is part of the join key, not just the
              // phone. Without it a Messenger PSID that happens to look like a
              // phone number would pull in a DIFFERENT person's WhatsApp
              // profile — showing one customer's name on another's thread.
              eq(customers.channel, conversations.channel),
              eq(customers.phone, conversations.customerPhone),
            ),
          )
          .leftJoin(
            customerLabels,
            and(
              eq(customerLabels.tenantId, conversations.tenantId),
              eq(customerLabels.customerId, customers.id),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(conversations.lastInboundAt), desc(conversations.id))
          .limit(limit + 1),
      tenantId,
    );

    const page = rows.slice(0, limit);
    const conversationIds = page.map((row) => row.id);
    const [aggregates, escalatedIds] = await Promise.all([
      this.messageAggregates(tenantId, conversationIds),
      this.escalatedConversationIds(tenantId, conversationIds),
    ]);

    const last = page[page.length - 1];
    return {
      items: page.map((row) => {
        const aggregate = aggregates.get(row.id);
        return {
          id: row.id,
          channel: row.channel,
          customerPhone: row.customerPhone,
          customerName: row.customerName ?? null,
          lastInboundAt: row.lastInboundAt,
          lastMessage: aggregate?.lastMessage ?? null,
          messageCount: aggregate?.messageCount ?? 0,
          escalated: escalatedIds.has(row.id),
          label: row.label ?? null,
        };
      }),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.lastInboundAt, id: last.id })
          : null,
    };
  }

  /** Thread header. Returns null for another tenant's id exactly as for a non-existent one — cross-tenant ids stay indistinguishable (same rule as `GET /kanban/tickets/:id`). */
  async getConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationDetail | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: conversations.id,
            channel: conversations.channel,
            customerPhone: conversations.customerPhone,
            lastInboundAt: conversations.lastInboundAt,
            rollingSummary: conversations.rollingSummary,
            createdAt: conversations.createdAt,
            handoverState: conversations.handoverState,
            handoverAt: conversations.handoverAt,
            handoverUserId: conversations.handoverUserId,
            customerName: customers.name,
          })
          .from(conversations)
          .leftJoin(
            customers,
            and(
              eq(customers.tenantId, conversations.tenantId),
              // Feature 16: the channel is part of the join key, not just the
              // phone. Without it a Messenger PSID that happens to look like a
              // phone number would pull in a DIFFERENT person's WhatsApp
              // profile — showing one customer's name on another's thread.
              eq(customers.channel, conversations.channel),
              eq(customers.phone, conversations.customerPhone),
            ),
          )
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );

    const row = rows[0];
    if (!row) return null;

    const [aggregates, escalatedIds] = await Promise.all([
      this.messageAggregates(tenantId, [row.id]),
      this.escalatedConversationIds(tenantId, [row.id]),
    ]);

    return {
      id: row.id,
      channel: row.channel,
      customerPhone: row.customerPhone,
      customerName: row.customerName ?? null,
      lastInboundAt: row.lastInboundAt,
      rollingSummary: row.rollingSummary,
      createdAt: row.createdAt,
      messageCount: aggregates.get(row.id)?.messageCount ?? 0,
      escalated: escalatedIds.has(row.id),
      handoverState: row.handoverState as HandoverState,
      handoverAt: row.handoverAt,
      handoverUserId: row.handoverUserId,
      // Evaluated at read time, not stored: the window is a deadline that
      // passes on its own, so a persisted boolean would be wrong within
      // hours of being written.
      replyWindow: this.channelPolicies.for(row.channel).evaluate({
        lastInboundAt: row.lastInboundAt,
        now: new Date(),
        // The only reader of this field is a human about to reply, which is
        // exactly the claim the HUMAN_AGENT extension is for. HumanReplyService
        // evaluates it the same way, so the console never shows a window the
        // send path then refuses (or vice versa).
        humanAgent: true,
      }),
      intake: await this.intakeFor(
        tenantId,
        conversationId,
        row.customerPhone,
        row.channel,
      ),
    };
  }

  /**
   * Collected values for this conversation, labelled with the tenant's own
   * wording rather than raw keys — a human reading a ticket should see
   * "Order number", not `order_number`.
   *
   * A value whose field has since been renamed or removed still shows, keyed
   * by its raw key: hiding data the customer actually gave because the
   * configuration moved on would be the wrong kind of tidy.
   */
  private async intakeFor(
    tenantId: string,
    conversationId: string,
    customerPhone: string,
    /** Feature 16: part of the customer identity, so customer-scoped intake never leaks across channels between two people with lookalike ids. */
    channel: ChannelKind,
  ): Promise<ConversationDetail['intake']> {
    const [perConversation, customerRows, labels] = await Promise.all([
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({
              key: conversationIntake.fieldKey,
              value: conversationIntake.value,
            })
            .from(conversationIntake)
            .where(
              and(
                eq(conversationIntake.conversationId, conversationId),
                eq(conversationIntake.tenantId, tenantId),
              ),
            ),
        tenantId,
      ),
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({
              key: customerAttributes.fieldKey,
              value: customerAttributes.value,
            })
            .from(customerAttributes)
            .innerJoin(
              customers,
              eq(customers.id, customerAttributes.customerId),
            )
            .where(
              and(
                eq(customers.tenantId, tenantId),
                eq(customers.channel, channel),
                eq(customers.phone, customerPhone),
              ),
            ),
        tenantId,
      ),
      this.intakeLabels(tenantId),
    ]);

    return [
      ...perConversation.map((row) => ({
        ...row,
        label: labels.get(row.key) ?? row.key,
        scope: 'conversation',
      })),
      ...customerRows.map((row) => ({
        ...row,
        label: labels.get(row.key) ?? row.key,
        scope: 'customer',
      })),
    ];
  }

  /** Field key -> the tenant's label, from whichever agents are published. */
  private async intakeLabels(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ intakeFields: agentVersions.intakeFields })
          .from(agents)
          .innerJoin(
            agentVersions,
            eq(agentVersions.id, agents.publishedVersionId),
          )
          .where(eq(agents.tenantId, tenantId)),
      tenantId,
    );

    const labels = new Map<string, string>();
    for (const row of rows) {
      for (const field of row.intakeFields ?? []) {
        labels.set(field.key, field.label);
      }
    }
    return labels;
  }

  /**
   * Transcript page, newest first. A thread view opens at the bottom and
   * loads backwards as the reader scrolls up, so "newest first" is what
   * makes the first page the useful one on a 60-turn conversation; the
   * client reverses each page for display.
   */
  async listMessages(
    tenantId: string,
    conversationId: string,
    limit: number,
    cursor: InboxCursor | null,
  ): Promise<Page<ConversationMessage>> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: messages.id,
            role: messages.role,
            content: messages.content,
            createdAt: messages.createdAt,
            deliveryStatus: messages.deliveryStatus,
            deliveryError: messages.deliveryError,
            authorUserId: messages.authorUserId,
            // F13: the attachment's metadata, never its bytes — a transcript
            // page carrying the files themselves would be megabytes.
            mediaStatus: messages.mediaStatus,
            mediaMimeType: messages.mediaMimeType,
            mediaSizeBytes: messages.mediaSizeBytes,
            mediaFilename: messages.mediaFilename,
            mediaError: messages.mediaError,
            mediaTranscript: messages.mediaTranscript,
            // Left-joined rather than fetched per message: a rating is a
            // property of the reply being read, and a second round trip per
            // bubble would be N+1 on the hottest read in the console.
            feedbackRating: answerFeedback.rating,
            feedbackNote: answerFeedback.note,
          })
          .from(messages)
          .leftJoin(answerFeedback, eq(answerFeedback.messageId, messages.id))
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.tenantId, tenantId),
              cursor
                ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor.at}, ${cursor.id}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(limit + 1),
      tenantId,
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        role: row.role as MessageRole,
        content: row.content,
        createdAt: row.createdAt,
        deliveryStatus: row.deliveryStatus as MessageDeliveryStatus | null,
        deliveryError: row.deliveryError,
        authorUserId: row.authorUserId,
        feedback:
          row.feedbackRating === null
            ? null
            : {
                rating: row.feedbackRating as 'up' | 'down',
                note: row.feedbackNote,
              },
        // Keyed off the status, not the storage key: a 'pending' or 'failed'
        // attachment has no key and must still be reported, or the reader is
        // shown a message that looks like it never had one.
        media: row.mediaStatus
          ? {
              status: row.mediaStatus,
              mimeType: row.mediaMimeType,
              sizeBytes: row.mediaSizeBytes,
              filename: row.mediaFilename,
              error: row.mediaError,
              transcript: row.mediaTranscript,
            }
          : null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /** One aggregate query for the whole page: per-conversation count plus its newest message, without pulling any transcript body the list will not render. */
  private async messageAggregates(
    tenantId: string,
    conversationIds: string[],
  ): Promise<Map<string, MessageAggregate>> {
    if (conversationIds.length === 0) return new Map();

    const result = await this.tenantContext.withTenantTx(
      (tx) =>
        tx.execute<MessageAggregateRow>(sql`
          select
            ${messages.conversationId} as conversation_id,
            count(*)::int as message_count,
            (array_agg(${messages.role} order by ${messages.createdAt} desc, ${messages.id} desc))[1] as last_role,
            (array_agg(${messages.content} order by ${messages.createdAt} desc, ${messages.id} desc))[1] as last_content,
            max(${messages.createdAt}) as last_created_at
          from ${messages}
          where ${inArray(messages.conversationId, conversationIds)} and ${eq(messages.tenantId, tenantId)}
          group by ${messages.conversationId}
        `),
      tenantId,
    );

    const aggregates = new Map<string, MessageAggregate>();
    for (const row of result.rows) {
      aggregates.set(row.conversation_id, {
        messageCount: Number(row.message_count),
        lastMessage:
          row.last_role !== null &&
          row.last_content !== null &&
          row.last_created_at !== null
            ? {
                role: row.last_role as MessageRole,
                content: row.last_content,
                createdAt: new Date(row.last_created_at),
              }
            : null,
      });
    }
    return aggregates;
  }

  /** Which of these conversations ever produced a ticket. Distinct ids only — a conversation with six tickets is still one boolean. */
  private async escalatedConversationIds(
    tenantId: string,
    conversationIds: string[],
  ): Promise<Set<string>> {
    if (conversationIds.length === 0) return new Set();

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .selectDistinct({ conversationId: tickets.conversationId })
          .from(tickets)
          .where(
            and(
              inArray(tickets.conversationId, conversationIds),
              eq(tickets.tenantId, tenantId),
            ),
          ),
      tenantId,
    );

    return new Set(
      rows
        .map((row) => row.conversationId)
        .filter((id): id is string => id !== null),
    );
  }
}
