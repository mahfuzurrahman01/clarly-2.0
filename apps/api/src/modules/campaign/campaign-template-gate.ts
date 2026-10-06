// F19 (D2): "approved templates only", in ONE place.
//
// `message_templates.approval_status` (F12) is the single source of truth and
// is reconciled against Meta by TemplateSyncService — F19 adds no second
// notion of approval. The gate is applied at FOUR points, because approval is
// revocable (Meta pauses or disables a template for quality at any time):
//
//   1. authoring          (POST /campaigns)
//   2. schedule           (POST /campaigns/:id/schedule)
//   3. launch             (scheduled -> sending): a campaign scheduled on
//                          Tuesday for Friday can have been rejected on
//                          Wednesday. Failing here means zero messages sent.
//   4. once per batch     — not per message. A template that flips mid-send
//                          moves the campaign to `paused_template` with its
//                          remaining recipients left pending.
//
// One function, four callers. A second copy of these rules is exactly how
// "approved" would come to mean two different things.
import { ConflictException } from '@nestjs/common';
import type { MessageTemplateRecord } from '../templates/message-template.service';
import { carriesMarketingOptOutInstruction } from './marketing-opt-out-fragment';

/** Every reason is a distinct, named 409 — a merchant needs to know WHICH check failed to fix it. */
export class CampaignTemplateGateError extends ConflictException {
  constructor(message: string) {
    super(message);
  }
}

export interface TemplateGateOptions {
  /**
   * Whether to require the body to carry an opt-out instruction. Applied
   * from the schedule step onward, not at authoring, so the first-slice
   * `POST /campaigns` contract is unchanged (see HANDOFF).
   */
  requireMarketingOptOut?: boolean;
}

export function assertTemplateSendable(
  template: MessageTemplateRecord,
  suppliedValueCount: number,
  options: TemplateGateOptions = {},
): void {
  if (template.kind !== 'whatsapp_template') {
    throw new CampaignTemplateGateError(
      `Template ${template.id} is a canned reply, not a WhatsApp template — a canned reply cannot be sent outside the 24h service window a broadcast requires.`,
    );
  }
  if (template.approvalStatus !== 'approved') {
    throw new CampaignTemplateGateError(
      `Template ${template.id} is "${template.approvalStatus}", not approved` +
        (template.approvalDetail ? `: ${template.approvalDetail}` : '.'),
    );
  }
  if (template.category !== 'MARKETING' && template.category !== 'UTILITY') {
    throw new CampaignTemplateGateError(
      `Template ${template.id} has category "${template.category}", which cannot be used in a broadcast campaign — only MARKETING or UTILITY templates are eligible.`,
    );
  }
  if (suppliedValueCount !== template.variables.length) {
    throw new CampaignTemplateGateError(
      `Template ${template.id} takes ${template.variables.length} value(s); ${suppliedValueCount} were supplied.`,
    );
  }
  if (
    options.requireMarketingOptOut === true &&
    template.category === 'MARKETING' &&
    !carriesMarketingOptOutInstruction(template.body)
  ) {
    throw new CampaignTemplateGateError(
      `Template ${template.id} is a MARKETING template with no opt-out instruction in its body. ` +
        'A WhatsApp template send transmits only the template name and its parameters — Meta renders the approved body — ' +
        'so the instruction cannot be appended at send time. Add "Reply STOP MARKETING or UNSUBSCRIBE to opt out" to the ' +
        'template in WhatsApp Manager, re-submit it for approval, and re-sync.',
    );
  }
}

/** The campaign category the D4 eligibility gate uses. UTILITY skips business verification; MARKETING does not. */
export function campaignCategory(
  template: MessageTemplateRecord,
): 'MARKETING' | 'UTILITY' {
  return template.category === 'UTILITY' ? 'UTILITY' : 'MARKETING';
}
