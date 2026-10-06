// Product shell (InboxModule): a person on the tenant's team replying to a
// customer from the console — SAAS_READINESS §2's last piece.
//
// The send itself is one line. Everything around it is the feature, and each
// guard below exists because skipping it produces a specific, silent failure:
//
//   - stored as `human_agent`, never `assistant`, so the agent does not later
//     read a person's promise as its own prior turn and defend it;
//   - the conversation moves to human handover, so the agent does not answer
//     over the person mid-conversation;
//   - the WhatsApp 24-hour window is checked BEFORE sending, because outside
//     it Meta rejects free-form text and the agent would otherwise believe
//     they had replied;
//   - a client-supplied id makes a double-click idempotent;
//   - the row is written BEFORE the send and marked failed after, so a
//     message that did not arrive is visible rather than absent.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppLoggerService } from '../core';
import { ConversationService } from '../conversation/conversation.service';
import { ConversationQueryService } from '../conversation/conversation-query.service';
import { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import { ChannelRegistry } from '../channel/channel-registry.service';
import { ChannelPolicyRegistry } from '../channel/channel-policy.registry';
import type { ChannelKind } from '../channel/ports/channel-kind';

export interface HumanReplyResult {
  messageId: string;
  delivered: boolean;
  /** Present when the BSP rejected the send; the reply is stored either way. */
  deliveryError: string | null;
}

@Injectable()
export class HumanReplyService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly conversationQuery: ConversationQueryService,
    private readonly numbers: WhatsappNumberDirectory,
    private readonly channels: ChannelRegistry,
    private readonly channelPolicies: ChannelPolicyRegistry,
    private readonly logger: AppLoggerService,
  ) {}

  async reply(input: {
    tenantId: string;
    conversationId: string;
    userId: string;
    text: string;
    clientMessageId: string;
  }): Promise<HumanReplyResult> {
    const conversation = await this.conversations.getConversation(
      input.tenantId,
      input.conversationId,
    );
    if (!conversation) {
      throw new NotFoundException(
        `Conversation ${input.conversationId} not found`,
      );
    }

    // Idempotency first: a retried send must not re-check the window, take
    // over the conversation again, or reach the BSP a second time.
    const existing = await this.conversations.findByClientMessageId(
      input.tenantId,
      input.clientMessageId,
    );
    if (existing) {
      return {
        messageId: existing.id,
        delivered: existing.deliveryStatus !== 'failed',
        deliveryError: existing.deliveryError,
      };
    }

    // Feature 16: the window is asked of the CHANNEL, not assumed to be
    // WhatsApp's 24 hours. `humanAgent: true` is the honest claim here — a
    // person really is typing this — and it is what earns Messenger's and
    // Instagram's 7-day HUMAN_AGENT extension. The agent's own send path
    // never sets it.
    const policy = this.channelPolicies.for(conversation.channel);
    const evaluation = {
      lastInboundAt: conversation.lastInboundAt,
      now: new Date(),
      humanAgent: true,
    };
    const window = policy.evaluate(evaluation);
    if (!window.open) {
      // Refused rather than attempted: the provider rejects free-form text
      // outside the window, and an agent who watched their message "send" and
      // never get a reply has no way to know that happened.
      throw new ConflictException(
        window.outOfWindowOptions.includes('template')
          ? "This conversation is outside WhatsApp's 24-hour reply window, so a free-form reply will not send. Use an approved template (POST /conversations/:id/template-messages), or wait for the customer to message first."
          : `This conversation is outside the ${conversation.channel} reply window, so a free-form reply will not send. Wait for the customer to message again.`,
      );
    }

    const channelAccountId = await this.resolveChannelAccountId(
      input.tenantId,
      conversation.channel,
      conversation.channelAccountId,
    );

    // Written before the send: if delivery fails the transcript still shows
    // what was said and that it did not arrive, which is the state a human
    // has to act on. The reverse order loses the message entirely on a crash.
    const messageId = await this.conversations.recordHumanAgentMessage({
      tenantId: input.tenantId,
      conversationId: conversation.id,
      content: input.text,
      authorUserId: input.userId,
      clientMessageId: input.clientMessageId,
    });

    // Taking over BEFORE delivery, not after: the customer may reply the
    // instant the message lands, and an agent still holding the floor at that
    // moment is exactly the double-answer this prevents.
    await this.conversations.startHandover(
      input.tenantId,
      conversation.id,
      input.userId,
      new Date(),
    );

    try {
      const adapter = this.channels.for(conversation.channel);
      const { providerMessageId } = await adapter.sendText({
        channelAccountId,
        to: conversation.customerPhone,
        body: input.text,
        // Null inside the window, HUMAN_AGENT on Messenger/Instagram when the
        // extension is what is keeping this send legal. Resolved by the
        // policy, never hardcoded here.
        ...((tag) => (tag ? { tag } : {}))(policy.outOfWindowTag(evaluation)),
      });
      await this.conversations.attachOutboundDelivery(
        input.tenantId,
        messageId,
        providerMessageId,
      );
      return { messageId, delivered: true, deliveryError: null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `human reply on conversation ${conversation.id} failed to send: ${detail}`,
        'HumanReplyService',
      );
      await this.conversations.markOutboundFailed(
        input.tenantId,
        messageId,
        detail,
      );
      // Not thrown: the reply is a real, stored event that simply did not
      // arrive, and the console needs to render it as such rather than show
      // an error and lose the text the agent typed.
      return { messageId, delivered: false, deliveryError: detail };
    }
  }

  /**
   * The account the customer has been talking to. Falls back to the tenant's
   * only WhatsApp number for conversations that predate recording it;
   * ambiguous is refused rather than guessed.
   *
   * The fallback is WhatsApp-only by construction: only WhatsApp conversations
   * can predate the column, since the social channels did not exist before it.
   * A social conversation with no recorded account is a real inconsistency and
   * is refused rather than papered over with a guess.
   */
  private async resolveChannelAccountId(
    tenantId: string,
    channel: ChannelKind,
    recorded: string | null,
  ): Promise<string> {
    if (recorded) return recorded;
    if (channel !== 'whatsapp') {
      throw new ConflictException(
        `This ${channel} conversation has no recorded account to reply from.`,
      );
    }

    const tenantNumbers = await this.numbers.listForTenant(tenantId);
    if (tenantNumbers.length === 1) return tenantNumbers[0].phoneNumberId;

    throw new ConflictException(
      tenantNumbers.length === 0
        ? 'This workspace has no WhatsApp number connected, so there is nothing to reply from.'
        : 'This conversation predates per-number tracking and the workspace has several numbers, so there is no way to tell which one to reply from.',
    );
  }
}
