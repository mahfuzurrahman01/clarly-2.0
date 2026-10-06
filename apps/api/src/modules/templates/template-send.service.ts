// The common half of every approved-template send (F26 D5).
//
// Extracted from `InboxModule`'s `TemplateReplyService`, which until now was
// the only template send path. F26 needs a second caller — an automated
// shipment notification — and `TemplateReplyService` cannot be reused as-is:
// it requires an `authorUserId`, writes the message as `role: 'human_agent'`,
// and calls `startHandover()`. All three are correct for a person pressing
// send and wrong for an automated notification, which must leave the
// conversation with the agent.
//
// So the guards move here and the two callers keep only what actually differs
// — who authors the message, and whether handover starts. A second copy of
// the approval/category/consent/render logic is exactly how those guards
// drift apart, and they are the guards that decide whether Meta bills the
// tenant for a policy violation.
//
// This service deliberately does NOT record the message row. Recording is the
// caller's half (`recordHumanAgentMessage` vs `recordSystemTemplateMessage`),
// and a callback parameter here would only be indirection around the same
// split.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { CustomerConsentService } from '../customer/customer-consent.service';
import { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import {
  BspAdapter,
  type BspTemplateStatus,
} from '../whatsapp/ports/bsp-adapter.port';
import {
  MessageTemplateService,
  type MessageTemplateRecord,
} from './message-template.service';
import { TemplateBodyError, renderTemplateBody } from './template-body';
import { toOperatorDeliveryError } from './delivery-error';

/** How long one number's WABA template listing is trusted. Short, so a freshly approved template is usable within a minute, long enough that a burst of sends is one Graph call. */
const LISTING_TTL_MS = 60_000;

/**
 * The conversation fields a send needs. Structural rather than an import of
 * `ConversationRecord`, so TemplatesModule does not have to depend on
 * ConversationModule for four fields.
 */
export interface TemplateSendConversation {
  id: string;
  customerPhone: string;
  channel: string;
  channelAccountId: string | null;
}

export type TemplateSendRefusal =
  | 'not_found'
  | 'not_a_whatsapp_template'
  | 'not_approved'
  | 'wrong_category'
  | 'unsupported_channel'
  | 'invalid_values'
  | 'opted_out'
  | 'no_sending_number'
  | 'ambiguous_sending_number'
  | 'not_on_whatsapp';

export interface TemplateSendPlan {
  template: MessageTemplateRecord;
  /** The RENDERED text. Stored, not the raw body: "{{1}}, your order {{2}} shipped" answers nothing for the next person who reads the transcript. */
  text: string;
  phoneNumberId: string;
}

export type TemplatePrepareResult =
  | { ok: true; plan: TemplateSendPlan }
  | { ok: false; reason: TemplateSendRefusal; message: string };

export interface TemplatePrepareInput {
  tenantId: string;
  conversation: TemplateSendConversation;
  templateId: string;
  values: string[];
  /**
   * When set, the template's `category` must equal this. F26 passes
   * `'utility'`: Meta bills and enforces per category, so sending a
   * marketing-category template for a shipment update is a policy violation
   * as well as a mis-bill. The human send path passes nothing, because a
   * person choosing a template is choosing its category too.
   */
  requireCategory?: string;
}

export interface TemplateDispatchResult {
  delivered: boolean;
  bspMessageId: string | null;
  deliveryError: string | null;
}

@Injectable()
export class TemplateSendService {
  private readonly listingCache = new Map<
    string,
    { at: number; listing: BspTemplateStatus[] | null }
  >();

  constructor(
    private readonly templates: MessageTemplateService,
    private readonly numbers: WhatsappNumberDirectory,
    private readonly consent: CustomerConsentService,
    private readonly bspAdapter: BspAdapter,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Runs every precondition and returns what to send, or why not.
   *
   * Refusals are returned rather than thrown because one caller needs them as
   * HTTP errors and the other needs them as recorded skip outcomes. Throwing
   * and catching to get the second shape would make the exception type the
   * contract, which is worse than a discriminated union.
   *
   * Order matters and is the same order the human path has always used:
   * existence, kind, approval, category, channel, consent, render, number.
   * Consent is checked before anything is recorded, so a blocked send leaves
   * no trace of a conversation that never happened.
   */
  async prepare(input: TemplatePrepareInput): Promise<TemplatePrepareResult> {
    const template = await this.templates.get(input.tenantId, input.templateId);
    if (!template) {
      return {
        ok: false,
        reason: 'not_found',
        message: `Template ${input.templateId} not found`,
      };
    }

    if (template.kind !== 'whatsapp_template') {
      return {
        ok: false,
        reason: 'not_a_whatsapp_template',
        message:
          'That is a canned reply, not a WhatsApp template. Canned replies only send inside the 24-hour window; send it as an ordinary reply instead.',
      };
    }

    // Refused before the BSP sees it. Meta answers an unapproved template
    // with a generic error that names neither the template nor the reason, so
    // a tenant who sent one would be left guessing — whereas the stored
    // approval state can say exactly what is wrong.
    if (template.approvalStatus !== 'approved') {
      return {
        ok: false,
        reason: 'not_approved',
        message:
          template.approvalStatus === 'rejected'
            ? `WhatsApp rejected this template${template.approvalDetail ? `: ${template.approvalDetail}` : ''}. Fix it in WhatsApp Manager and re-sync before using it.`
            : `This template is "${template.approvalStatus}", not approved. Only a template WhatsApp has approved will send.`,
      };
    }

    if (input.requireCategory && template.category !== input.requireCategory) {
      return {
        ok: false,
        reason: 'wrong_category',
        message: `This template's category is "${template.category ?? 'unset'}", but this send requires a "${input.requireCategory}" template.`,
      };
    }

    // A template is business-initiated by definition — it is the one send
    // that reaches a customer who did not just message us.
    if (
      await this.consent.isOptedOut(
        input.tenantId,
        input.conversation.customerPhone,
        input.conversation.channel as 'whatsapp',
      )
    ) {
      return {
        ok: false,
        reason: 'opted_out',
        message:
          'This customer has opted out of messages. A template cannot be sent to them until they opt back in.',
      };
    }

    let text: string;
    try {
      text = renderTemplateBody(template.body, input.values);
    } catch (error) {
      if (error instanceof TemplateBodyError) {
        return {
          ok: false,
          reason: 'invalid_values',
          message: error.message,
        };
      }
      throw error;
    }

    // Templates are a WhatsApp-only mechanism (F12/D9). Messenger and
    // Instagram use message TAGS instead — a different send with different
    // rules — so this refuses them rather than sending something the provider
    // will reject.
    if (input.conversation.channel !== 'whatsapp') {
      return {
        ok: false,
        reason: 'unsupported_channel',
        message: `Approved templates are a WhatsApp mechanism; this conversation is on ${input.conversation.channel}. Reply inside the messaging window instead.`,
      };
    }

    const numberResult = await this.resolvePhoneNumberId(
      input.tenantId,
      input.conversation.channelAccountId,
    );
    if (!numberResult.ok) return numberResult;

    const missing = await this.findMissingOnWhatsapp(
      template,
      numberResult.phoneNumberId,
    );
    if (missing) return { ok: false, ...missing };

    return {
      ok: true,
      plan: { template, text, phoneNumberId: numberResult.phoneNumberId },
    };
  }

  /**
   * The BSP call. Never throws for a send failure: a message that did not
   * arrive is a real event that belongs in the transcript marked as such, and
   * both callers need to record it rather than unwind.
   */
  async dispatch(input: {
    plan: TemplateSendPlan;
    to: string;
    values: string[];
    /** For the log line only. */
    context: string;
  }): Promise<TemplateDispatchResult> {
    try {
      const { bspMessageId } = await this.bspAdapter.sendTemplateMessage({
        phoneNumberId: input.plan.phoneNumberId,
        to: input.to,
        templateName: input.plan.template.name,
        language: input.plan.template.language,
        bodyParameters: input.values,
      });
      return { delivered: true, bspMessageId, deliveryError: null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `template "${input.plan.template.name}" (${input.context}) failed to send: ${detail}`,
        'TemplateSendService',
      );
      return {
        delivered: false,
        bspMessageId: null,
        deliveryError: toOperatorDeliveryError(error),
      };
    }
  }

  /**
   * ISSUE-002: the stored `approved` is a copy of what Meta once said (or, for
   * seeded data, of what nobody ever asked Meta). Before spending a send on it,
   * confirm the sending number's WABA lists this name AND language as APPROVED —
   * Meta's own answer for a miss (#132001) names neither.
   *
   * Fails OPEN: an adapter that cannot list, or a listing call that errors,
   * must not turn a Meta read outage into a send outage. The send itself still
   * fails loudly if the template really is missing.
   */
  private async findMissingOnWhatsapp(
    template: MessageTemplateRecord,
    phoneNumberId: string,
  ): Promise<{ reason: TemplateSendRefusal; message: string } | null> {
    const listing = await this.listFor(phoneNumberId);
    if (!listing) return null;

    const language = template.language.toLowerCase();
    const sameName = listing.filter((entry) => entry.name === template.name);
    const exact = sameName.find(
      (entry) => entry.language.toLowerCase() === language,
    );
    if (exact?.status === 'APPROVED') return null;

    const where = `on this number's WhatsApp Business account`;
    if (exact) {
      return {
        reason: 'not_on_whatsapp',
        message: `Template "${template.name}" (${template.language}) exists ${where} but its status is ${exact.status}${exact.reason ? ` (${exact.reason})` : ''}, not APPROVED. Fix it in WhatsApp Manager and re-sync.`,
      };
    }
    const hint =
      sameName.length > 0
        ? ` It exists in other languages: ${sameName.map((entry) => entry.language).join(', ')}.`
        : '';
    return {
      reason: 'not_on_whatsapp',
      message: `Template "${template.name}" (${template.language}) does not exist ${where}, so WhatsApp would reject the send.${hint} Create or submit it in WhatsApp Manager, then re-sync templates.`,
    };
  }

  private async listFor(
    phoneNumberId: string,
  ): Promise<BspTemplateStatus[] | null> {
    const cached = this.listingCache.get(phoneNumberId);
    if (cached && Date.now() - cached.at < LISTING_TTL_MS) {
      return cached.listing;
    }
    try {
      const listing = await this.bspAdapter.listTemplates(phoneNumberId);
      this.listingCache.set(phoneNumberId, { at: Date.now(), listing });
      return listing;
    } catch (error) {
      this.logger.warn(
        `TemplateSendService: could not list templates for ${phoneNumberId}, skipping the pre-send check: ${
          error instanceof Error ? error.message : String(error)
        }`,
        TemplateSendService.name,
      );
      return null;
    }
  }

  /** The number the customer has been talking to. Ambiguity is refused rather than guessed. */
  private async resolvePhoneNumberId(
    tenantId: string,
    recorded: string | null,
  ): Promise<
    | { ok: true; phoneNumberId: string }
    | { ok: false; reason: TemplateSendRefusal; message: string }
  > {
    if (recorded) return { ok: true, phoneNumberId: recorded };

    const tenantNumbers = await this.numbers.listForTenant(tenantId);
    if (tenantNumbers.length === 1) {
      return { ok: true, phoneNumberId: tenantNumbers[0].phoneNumberId };
    }
    return tenantNumbers.length === 0
      ? {
          ok: false,
          reason: 'no_sending_number',
          message:
            'This workspace has no WhatsApp number connected, so there is nothing to send from.',
        }
      : {
          ok: false,
          reason: 'ambiguous_sending_number',
          message:
            'This conversation predates per-number tracking and the workspace has several numbers, so there is no way to tell which one to send from.',
        };
  }
}
