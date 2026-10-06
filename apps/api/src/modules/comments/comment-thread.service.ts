// Gulf T8 (D15b): a private reply opens nothing until the customer answers.
//
// When a Messenger/Instagram DM arrives, the webhook ingest asks this service
// whether the sender has a private reply waiting on them. If so, THIS is the
// moment the conversation starts: the customer and conversation rows are
// created, the private reply we sent is written into the thread as the
// agent's first message (so the inbox shows what the customer is answering,
// and the agent's next turn has it in its history), the customer gets the
// F18 label the comment's intent justifies, and the comment rows are linked
// to the conversation. The DM itself then continues down the normal respond
// path — same agent core, same inbox, same labels as any other DM.
import { Injectable } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { CustomerLabelService } from '../customer/customer-label.service';
import { CustomerService } from '../customer/customer.service';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { CommentLedgerService } from './comment-ledger.service';
import { labelForCommentIntent } from './comment-policy';

/** Channels whose accounts receive comment private replies. */
const COMMENT_CHANNELS: ReadonlySet<ChannelKind> = new Set([
  'messenger',
  'instagram',
]);

export interface CustomerMessageRef {
  tenantId: string;
  channel: ChannelKind;
  channelAccountId: string;
  /** The DM sender: PSID / IGSID. */
  from: string;
}

export interface AdoptedCommentThread {
  conversationId: string;
  commentEventIds: string[];
}

@Injectable()
export class CommentThreadService {
  constructor(
    private readonly ledger: CommentLedgerService,
    private readonly customers: CustomerService,
    private readonly conversations: ConversationService,
    private readonly labels: CustomerLabelService,
  ) {}

  /**
   * Adopts every private-reply thread waiting on this sender, or returns null
   * when there is none (the common case: one indexed lookup). Idempotent: an
   * adopted thread is `replied` and never adopted twice, and the webhook
   * dedup has already dropped a replayed DM before this runs.
   */
  async adoptOnCustomerMessage(
    message: CustomerMessageRef,
  ): Promise<AdoptedCommentThread | null> {
    if (!COMMENT_CHANNELS.has(message.channel)) return null;

    const threads = await this.ledger.adoptAwaitingThreads(
      message.tenantId,
      message.channelAccountId,
      message.from,
    );
    if (threads.length === 0) return null;

    const customer = await this.customers.getOrCreateByPhone(
      message.tenantId,
      message.from,
      message.channel,
    );
    const conversation = await this.conversations.getOrCreateConversation(
      message.tenantId,
      message.from,
      message.channelAccountId,
      message.channel,
    );

    for (const thread of threads) {
      if (!thread.privateReplyText) continue;
      const messageId = await this.conversations.recordAssistantMessage(
        message.tenantId,
        conversation.id,
        thread.privateReplyText,
      );
      if (thread.privateReplyMessageId) {
        await this.conversations.attachOutboundDelivery(
          message.tenantId,
          messageId,
          thread.privateReplyMessageId,
        );
      }
    }

    await this.ledger.linkConversation(
      message.tenantId,
      threads.map((thread) => thread.id),
      conversation.id,
    );

    // The strongest signal wins when several comments led here.
    const candidates = threads.map((thread) =>
      labelForCommentIntent(thread.intent),
    );
    const label = candidates.includes('hot')
      ? 'hot'
      : (candidates.find((candidate) => candidate !== null) ?? null);
    if (label) {
      await this.labels.applyAgentLabel(message.tenantId, customer.id, label);
    }

    return {
      conversationId: conversation.id,
      commentEventIds: threads.map((thread) => thread.id),
    };
  }
}
