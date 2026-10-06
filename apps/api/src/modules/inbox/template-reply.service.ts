// Product shell (InboxModule, F12): sending an approved template to a
// customer whose 24-hour window has shut.
//
// This is the other half of HumanReplyService. That service refuses outside
// the window — correctly, because Meta rejects free-form text there — and
// until now that refusal was a dead end: a customer who went quiet for a day
// could not be reached at all, on exactly the conversations where somebody
// needed to follow up.
//
// A separate service rather than a branch inside HumanReplyService because
// the two share almost nothing but the storage call. A template send has its
// own preconditions (approval state, value count), its own inverted window
// rule, and a different failure mode — and folding them together would put
// two send paths behind one set of guards where each needs its own.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import {
  TemplateSendService,
  type TemplateSendRefusal,
} from '../templates/templates.module';

export interface TemplateReplyResult {
  messageId: string;
  delivered: boolean;
  /** What the customer reads — stored and returned, because a transcript showing `{{1}}` tells the next person nothing. */
  text: string;
  deliveryError: string | null;
}

@Injectable()
export class TemplateReplyService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly templateSend: TemplateSendService,
  ) {}

  async send(input: {
    tenantId: string;
    conversationId: string;
    userId: string;
    templateId: string;
    values: string[];
    clientMessageId: string;
  }): Promise<TemplateReplyResult> {
    const conversation = await this.conversations.getConversation(
      input.tenantId,
      input.conversationId,
    );
    if (!conversation) {
      throw new NotFoundException(
        `Conversation ${input.conversationId} not found`,
      );
    }

    // Idempotency first, same as HumanReplyService: a retried send must not
    // reach the BSP a second time. A template send costs the tenant money per
    // message, which makes a double-send worse here than for a free-form one.
    const existing = await this.conversations.findByClientMessageId(
      input.tenantId,
      input.clientMessageId,
    );
    if (existing) {
      return {
        messageId: existing.id,
        delivered: existing.deliveryStatus !== 'failed',
        text: existing.content,
        deliveryError: existing.deliveryError,
      };
    }

    // Every precondition — kind, approval, consent, render, channel, sending
    // number — now lives in TemplateSendService, shared with F26's automated
    // shipment notifications. The refusals come back as data and are turned
    // into the same HTTP errors this endpoint has always returned.
    //
    // No `requireCategory`: a person choosing a template is choosing its
    // category too. Only the automated path pins `utility`.
    const prepared = await this.templateSend.prepare({
      tenantId: input.tenantId,
      conversation,
      templateId: input.templateId,
      values: input.values,
    });
    if (!prepared.ok) {
      throw toHttpError(prepared.reason, prepared.message);
    }
    const { plan } = prepared;

    // The rendered text is stored, not the raw body: the transcript is what
    // the next person reads to find out what this customer was told, and
    // "{{1}}, your order {{2}} shipped" answers that for nobody.
    const messageId = await this.conversations.recordHumanAgentMessage({
      tenantId: input.tenantId,
      conversationId: conversation.id,
      content: plan.text,
      authorUserId: input.userId,
      clientMessageId: input.clientMessageId,
    });

    // Taken over for the same reason a free-form reply is: the customer may
    // answer the template immediately, and the agent must not be holding the
    // floor when they do. This is the half F26's automated path deliberately
    // does NOT share — a shipment notification must leave the conversation
    // with the agent.
    await this.conversations.startHandover(
      input.tenantId,
      conversation.id,
      input.userId,
      new Date(),
    );

    const dispatch = await this.templateSend.dispatch({
      plan,
      to: conversation.customerPhone,
      values: input.values,
      context: `conversation ${conversation.id}`,
    });

    if (dispatch.delivered && dispatch.bspMessageId) {
      await this.conversations.attachOutboundDelivery(
        input.tenantId,
        messageId,
        dispatch.bspMessageId,
      );
      return {
        messageId,
        delivered: true,
        text: plan.text,
        deliveryError: null,
      };
    }

    const detail = dispatch.deliveryError ?? 'send failed';
    await this.conversations.markOutboundFailed(
      input.tenantId,
      messageId,
      detail,
    );
    // Not thrown, matching HumanReplyService: the message is a real event
    // that did not arrive, and it belongs in the transcript marked as such.
    return {
      messageId,
      delivered: false,
      text: plan.text,
      deliveryError: detail,
    };
  }
}

/**
 * The refusal -> HTTP mapping this endpoint has always used, kept here rather
 * than in TemplateSendService: the shared service has a second caller that
 * records these as skip outcomes instead of raising them, and a service that
 * threw HTTP exceptions would force that caller to catch them.
 *
 * Notably absent throughout: a check that the 24-hour window is SHUT. An
 * approved template is valid inside the window too, and refusing one there
 * would block the legitimate case of a person opening a conversation with a
 * structured message. The window rule is one-directional — free-form text is
 * what the window restricts, not templates.
 */
function toHttpError(reason: TemplateSendRefusal, message: string): Error {
  switch (reason) {
    case 'not_found':
      return new NotFoundException(message);
    case 'not_a_whatsapp_template':
    case 'invalid_values':
      return new BadRequestException(message);
    default:
      return new ConflictException(message);
  }
}
