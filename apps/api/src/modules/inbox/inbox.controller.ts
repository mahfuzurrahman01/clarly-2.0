// Product shell (InboxModule): the conversation inbox API — the read
// surface a human uses to audit conversations the agent handled *without*
// escalating, which is most of them and exactly the traffic a tenant wants
// to judge the agent on. The kanban board only ever shows a conversation
// that produced a ticket, and only its last 10 messages.
//
// Ungated by role, for the same reason KanbanController is: T14 draws the
// admin/agent line at team/tenant-config/policy access, not at reading the
// tenant's own support traffic.
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Audit, type AuditDetailWithOutcome } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { EntitlementGuard } from '../billing/entitlement.guard';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ApiErrorDto,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ConversationQueryService } from '../conversation/conversation-query.service';
import { ConversationService } from '../conversation/conversation.service';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { AnswerFeedbackService } from './answer-feedback.service';
import {
  HumanReplyService,
  type HumanReplyResult,
} from './human-reply.service';
import {
  TemplateReplyService,
  type TemplateReplyResult,
} from './template-reply.service';
import { decodeCursor, type InboxCursor } from '../conversation/inbox-cursor';
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  Page,
} from '../conversation/conversation-query.dto';
import {
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  rateAnswerBodySchema,
  sendReplyBodySchema,
  sendTemplateBodySchema,
  ConversationDetailDto,
  ConversationPageDto,
  RateAnswerBodyDto,
  SendReplyBodyDto,
  SendReplyResultDto,
  SendTemplateBodyDto,
  SendTemplateResultDto,
  ListConversationsQueryDto,
  ListMessagesQueryDto,
  MessagePageDto,
} from './inbox.dto';

const CONVERSATION_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description:
    'Conversation id. A non-UUID value is rejected with 400 by ParseUUIDPipe.',
} as const;

const CURSOR_DESCRIPTION =
  'Paginate with `nextCursor` from the previous response; a null `nextCursor` means the last page.';

@ApiTags('inbox')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('conversations')
export class InboxController {
  constructor(
    private readonly conversationQuery: ConversationQueryService,
    private readonly conversationService: ConversationService,
    private readonly humanReply: HumanReplyService,
    private readonly templateReply: TemplateReplyService,
    private readonly answerFeedback: AnswerFeedbackService,
    private readonly storage: ObjectStorage,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List conversations',
    description: `Every conversation in the calling tenant, newest inbound activity first, each with a last-message preview and whether it ever escalated. ${CURSOR_DESCRIPTION}`,
  })
  @ApiOkResponse({ type: ConversationPageDto })
  @ApiValidationErrorResponse()
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listConversationsQuerySchema))
    query: ListConversationsQueryDto,
  ): Promise<Page<ConversationSummary>> {
    return this.conversationQuery.listConversations(
      auth.tenantId,
      {
        phone: query.phone,
        from: query.from,
        to: query.to,
        escalated: query.escalated,
      },
      query.limit,
      parseCursor(query.cursor),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one conversation',
    description:
      "Thread header: customer identity, message count, escalation flag, and the agent's rolling summary. Another tenant's id returns 404, not 403 — cross-tenant ids are indistinguishable from non-existent ones by design. A conversation whose retention window has expired (T16) is gone entirely, so a stale link 404s rather than returning an empty thread.",
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiOkResponse({ type: ConversationDetailDto })
  @ApiResponse({
    status: 404,
    description: 'No such conversation in the calling tenant.',
    type: ApiErrorDto,
  })
  get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDetail> {
    return this.requireConversation(auth.tenantId, id);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'Get a conversation transcript',
    description: `The full transcript, **newest first** — a thread view opens at the bottom and pages backwards as the reader scrolls up, so reverse each page for display. ${CURSOR_DESCRIPTION}\n\nReturns an empty page rather than 404 for a conversation whose messages have been purged but whose row still exists; check \`GET /conversations/:id\` for whether the conversation itself is gone.`,
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiOkResponse({ type: MessagePageDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 404,
    description: 'No such conversation in the calling tenant.',
    type: ApiErrorDto,
  })
  async messages(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema))
    query: ListMessagesQueryDto,
  ): Promise<Page<ConversationMessage>> {
    // Existence is checked first so a transcript request for another
    // tenant's (or a purged) conversation 404s instead of returning an
    // indistinguishable empty page.
    await this.requireConversation(auth.tenantId, id);

    return this.conversationQuery.listMessages(
      auth.tenantId,
      id,
      query.limit,
      parseCursor(query.cursor),
    );
  }

  @Get(':id/messages/:messageId/media')
  @ApiOperation({
    summary: "Download a customer's attachment",
    description:
      "The bytes of an image, voice note or document the customer sent. Available only once `media.status` on the message is `stored`; anything else 404s, because there is nothing to serve.\n\nServed as an **attachment**, with `Content-Disposition` and `X-Content-Type-Options: nosniff`. The content type comes from the BSP and is therefore attacker-influenced — rendering it inline off this response would make the transcript an upload-anything-execute-anything surface. A console that wants to show a photo should fetch this and decide for itself.\n\nAnother tenant's message id 404s exactly as a non-existent one does.",
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiParam({ name: 'messageId', format: 'uuid' })
  @ApiOkResponse({
    description: 'The raw bytes.',
    content: { 'application/octet-stream': {} },
  })
  @ApiResponse({
    status: 404,
    description:
      'No such message in the calling tenant, or it has no stored attachment.',
    type: ApiErrorDto,
  })
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadMedia(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Res() response: Response,
  ): Promise<void> {
    const media = await this.conversationService.findMediaMessage(
      auth.tenantId,
      id,
      messageId,
    );
    if (!media) {
      throw new NotFoundException(
        `Message ${messageId} has no stored attachment`,
      );
    }

    const content = await this.storage.download(media.storageKey);

    // `attachment`, never `inline`: the filename and content type both came
    // from the customer via the BSP, and serving unknown bytes inline off an
    // authenticated origin is how a support transcript becomes an XSS vector.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename(media.filename)}"`,
    );
    response.setHeader(
      'Content-Type',
      media.mimeType ?? 'application/octet-stream',
    );
    response.setHeader('Content-Length', content.byteLength);
    response.end(content);
  }

  @Post(':id/messages')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Reply to the customer',
    description:
      "Sends a message to the customer as a **human agent**, and takes the conversation over so the AI agent stops answering — otherwise the customer gets two different answers to the same question.\n\nRefused with **409** outside WhatsApp's 24-hour reply window: Meta rejects free-form text there, and an agent who watched their message send and never get a reply has no way to know that happened.\n\n`clientMessageId` makes this idempotent — sending the same id twice returns the first result rather than messaging the customer twice.\n\nA send the BSP rejects returns **201 with `delivered: false`**, not an error: the reply is a real event that did not arrive, and it belongs in the transcript marked as such rather than vanishing along with the text the agent typed.",
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiCreatedResponse({ type: SendReplyResultDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 409,
    description:
      'Outside the 24-hour window, or there is no single number to reply from.',
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No such conversation in the calling tenant.',
    type: ApiErrorDto,
  })
  sendReply(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(sendReplyBodySchema)) body: SendReplyBodyDto,
  ): Promise<HumanReplyResult> {
    return this.humanReply.reply({
      tenantId: auth.tenantId,
      conversationId: id,
      userId: auth.userId,
      text: body.text,
      clientMessageId: body.clientMessageId,
    });
  }

  @Post(':id/template-messages')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Send an approved template to the customer',
    description:
      "The way to reach a customer once the 24-hour window has shut — WhatsApp accepts nothing else there, so `POST /conversations/:id/messages` is refused and this is the only route through.\n\nThe template must be an **approved** `whatsapp_template`; a canned reply is a 400 and a pending or rejected one is a 409, both checked before Meta sees the request. Meta's own error for an unapproved template names neither the template nor the reason, so a send that reached it would leave the tenant guessing.\n\nWorks inside the window too. The window restricts free-form text, not templates, and opening a conversation with a structured message is legitimate.\n\nThe **rendered** text is what lands in the transcript, and taking the conversation over works exactly as it does for a free-form reply. A send the BSP rejects returns **201 with `delivered: false`** rather than an error, for the same reason.",
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiCreatedResponse({ type: SendTemplateResultDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 409,
    description:
      'The template is not approved, or there is no single number to send from.',
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No such conversation or template in the calling tenant.',
    type: ApiErrorDto,
  })
  async sendTemplate(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(sendTemplateBodySchema))
    body: SendTemplateBodyDto,
    @Audit() audit: AuditDetailWithOutcome,
  ): Promise<TemplateReplyResult> {
    const result = await this.templateReply.send({
      tenantId: auth.tenantId,
      conversationId: id,
      userId: auth.userId,
      templateId: body.templateId,
      values: body.values,
      clientMessageId: body.clientMessageId,
    });
    // Answered 201 by design (the message is a real event in the transcript),
    // but the audit log must not read a rejected send as a success.
    if (!result.delivered) {
      audit.fail('template_message.not_delivered', {
        error: result.deliveryError ?? 'send failed',
      });
    }
    return result;
  }

  @Post(':id/messages/:messageId/feedback')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Rate an agent reply',
    description:
      'Marks one **agent** reply good or bad, with an optional note. Rating the same reply again replaces the previous verdict rather than stacking — "is this answer good" has one current answer, not a vote count.\n\nOnly `assistant` messages can be rated: a customer\'s own message or a teammate\'s reply would be noise in the eval corpus this exists to build.',
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiParam({ name: 'messageId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Recorded.' })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 404,
    description: 'No such agent reply in that conversation.',
    type: ApiErrorDto,
  })
  async rateAnswer(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body(new ZodValidationPipe(rateAnswerBodySchema)) body: RateAnswerBodyDto,
  ): Promise<{ ok: true }> {
    await this.answerFeedback.rate({
      tenantId: auth.tenantId,
      conversationId: id,
      messageId,
      rating: body.rating,
      note: body.note ?? null,
      userId: auth.userId,
    });
    return { ok: true };
  }

  @Delete(':id/messages/:messageId/feedback')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Withdraw a rating',
    description:
      'Distinct from a thumbs-down: "I have no opinion" must not read as "this answer was wrong" in the eval corpus.',
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiParam({ name: 'messageId', format: 'uuid' })
  @ApiOkResponse({ description: 'Cleared.' })
  @ApiResponse({
    status: 404,
    description: 'No such agent reply in that conversation.',
    type: ApiErrorDto,
  })
  async clearAnswerRating(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<{ ok: true }> {
    await this.answerFeedback.clear({
      tenantId: auth.tenantId,
      conversationId: id,
      messageId,
    });
    return { ok: true };
  }

  @Post(':id/handover')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Take a conversation over from the agent',
    description:
      "Silences the agent for this conversation: inbound messages are still recorded, but no turn runs and nothing is sent, so the customer never gets an AI answer on top of a human's.\n\nTaking over a conversation someone else already holds returns 409 — two people each believing they own a thread is exactly the failure this state exists to prevent. Re-taking your own is idempotent.\n\nA handover that is never handed back returns to the agent automatically after an hour of inbound traffic finding it stale; it is not a permanent mute.",
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiCreatedResponse({
    type: ConversationDetailDto,
    description: 'The conversation, now in human hands.',
  })
  @ApiResponse({
    status: 409,
    description: 'Another user already holds this conversation.',
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No such conversation in the calling tenant.',
    type: ApiErrorDto,
  })
  async takeOver(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDetail> {
    const conversation = await this.requireConversation(auth.tenantId, id);

    if (
      conversation.handoverState === 'human' &&
      // Null holder = paused by a WhatsApp Business app reply (Gulf T3,
      // D13), not a teammate: anyone may take it over.
      conversation.handoverUserId !== null &&
      conversation.handoverUserId !== auth.userId
    ) {
      throw new ConflictException(
        `Conversation ${id} is already held by another user.`,
      );
    }

    await this.conversationService.startHandover(
      auth.tenantId,
      id,
      auth.userId,
      new Date(),
    );
    return this.requireConversation(auth.tenantId, id);
  }

  @Post(':id/handover/return')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Hand a conversation back to the agent',
    description:
      'The agent resumes answering the next inbound message. Safe to call on a conversation that is already agent-handled — returning something nobody holds is a no-op, not an error, so a double-click cannot fail.',
  })
  @ApiParam(CONVERSATION_ID_PARAM)
  @ApiCreatedResponse({
    type: ConversationDetailDto,
    description: 'The conversation, back with the agent.',
  })
  @ApiResponse({
    status: 404,
    description: 'No such conversation in the calling tenant.',
    type: ApiErrorDto,
  })
  async returnToAgent(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDetail> {
    await this.requireConversation(auth.tenantId, id);
    await this.conversationService.returnToAgent(auth.tenantId, id, new Date());
    return this.requireConversation(auth.tenantId, id);
  }

  private async requireConversation(
    tenantId: string,
    id: string,
  ): Promise<ConversationDetail> {
    const conversation = await this.conversationQuery.getConversation(
      tenantId,
      id,
    );
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }
}

/**
 * Strips everything a `Content-Disposition` header cannot safely carry.
 *
 * The filename came from the customer. Quotes, newlines and control
 * characters in it would let them inject header content, so the value is
 * rebuilt from a conservative allowlist rather than escaped.
 */
function safeFilename(filename: string | null): string {
  const cleaned = (filename ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/** A malformed cursor is client error, not a silently-ignored filter — returning page 1 for a corrupted cursor would look like the list restarting at random. */
function parseCursor(raw: string | undefined): InboxCursor | null {
  if (!raw) return null;

  const cursor = decodeCursor(raw);
  if (!cursor) {
    throw new BadRequestException('Malformed `cursor`.');
  }
  return cursor;
}
