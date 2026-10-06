// Product shell (TemplatesModule, F12): registering a stored template with
// the BSP for review.
//
// This closes the gap that made F12 a dead end. `POST /templates` writes a
// row at `pending`; `TemplateSyncService` reads back what the BSP already
// knows; the send path refuses anything not `approved`. Nothing told Meta the
// template existed, so `approved` was unreachable and the entire
// outside-the-24-hour-window path — the reason templates exist at all —
// stayed shut.
//
// Deliberately explicit (`POST /templates/:id/submit`) rather than folded
// into create/update, mirroring `POST /templates/sync`:
//
//   create ──► stored `pending`, purely local, cannot fail on a Meta outage
//                  │
//                  ▼
//   submit ──► BSP review requested ──► `pending`, syncedAt stamped
//                  │                          │
//                  │                          ▼
//                  │                     sync ──► approved / rejected
//                  ▼
//            edit body ──► resets to `pending` (message-template.service.ts)
//                          and requires a DELIBERATE resubmit, so a typo fix
//                          never silently burns a Meta review cycle.
//
// Failure posture throughout: never mark a template as further along than it
// is. An adapter that cannot submit, a number with no credentials, and a
// rejected submission are three different outcomes and are reported as three
// different things.
import { BadRequestException, Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  BspAdapter,
  type BspTemplateSubmission,
} from '../whatsapp/ports/bsp-adapter.port';
import { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import { templatePositions } from './template-body';
import {
  MessageTemplateService,
  type MessageTemplateRecord,
} from './message-template.service';

export interface TemplateSubmissionResult {
  /** True when a BSP accepted the template for review. False means nothing was sent and the stored status is unchanged. */
  submitted: boolean;
  /** The BSP's own id, when it issued one — kept because a rejection appeal needs it. */
  providerTemplateId: string | null;
  /** Set when `submitted` is false: why no BSP could take it. */
  unsupportedReason: string | null;
}

@Injectable()
export class TemplateSubmissionService {
  constructor(
    private readonly templates: MessageTemplateService,
    private readonly numbers: WhatsappNumberDirectory,
    private readonly bspAdapter: BspAdapter,
    private readonly logger: AppLoggerService,
  ) {}

  async submit(
    tenantId: string,
    templateId: string,
  ): Promise<TemplateSubmissionResult> {
    const template = await this.templates.require(tenantId, templateId);

    assertSubmittable(template);
    const bodyExamples = collectBodyExamples(template);

    const numbers = await this.numbers.listForTenant(tenantId);
    if (numbers.length === 0) {
      return unsupported(
        'This workspace has no connected WhatsApp number, so there is no Business account to register the template against.',
      );
    }

    // First number that can actually submit wins. A tenant with two numbers on
    // two Business accounts has two template sets, but a template only needs
    // to exist in one to be sendable from it — submitting to every account
    // would create duplicates the tenant never asked for.
    for (const number of numbers) {
      let accepted: BspTemplateSubmission | null;
      try {
        accepted = await this.bspAdapter.submitTemplate({
          phoneNumberId: number.phoneNumberId,
          name: template.name,
          language: template.language,
          category: template.category ?? 'UTILITY',
          body: template.body,
          bodyExamples,
        });
      } catch (error) {
        // A rejection from one account must not be swallowed — it carries the
        // policy reason the tenant needs — but it also must not stop a second
        // account from succeeding. Recorded, then continue.
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `TemplateSubmissionService: submission of ${template.name} to ${number.phoneNumberId} failed: ${detail}`,
          TemplateSubmissionService.name,
        );
        continue;
      }

      if (!accepted) continue;

      // Stamped `pending`, never `approved`: the BSP accepted it for review,
      // which is not the same as passing review. Only a sync against the
      // BSP's own listing may write `approved`.
      await this.templates.recordApproval(
        tenantId,
        template.id,
        'pending',
        null,
        new Date(),
      );

      return {
        submitted: true,
        providerTemplateId: accepted.providerTemplateId,
        unsupportedReason: null,
      };
    }

    return unsupported(
      'No connected WhatsApp number could register the template — the channel either does not support submission or its credentials are incomplete. The template is unchanged.',
    );
  }
}

function unsupported(reason: string): TemplateSubmissionResult {
  return {
    submitted: false,
    providerTemplateId: null,
    unsupportedReason: reason,
  };
}

/** A canned reply has no BSP counterpart, and an already-approved template must not be resubmitted — Meta treats a duplicate name+language as a conflict, not an update. */
function assertSubmittable(template: MessageTemplateRecord): void {
  if (template.kind !== 'whatsapp_template') {
    throw new BadRequestException(
      'Only a whatsapp_template can be submitted for review. A canned reply is local to this workspace and never goes through the BSP.',
    );
  }
  if (template.approvalStatus === 'approved') {
    throw new BadRequestException(
      'This template is already approved. Edit its body first — that resets it to pending — then submit again.',
    );
  }
}

/**
 * One example per `{{n}}`, in position order.
 *
 * Meta rejects a template that has placeholders and no samples, because a
 * reviewer cannot judge "Your order {{1}} ships {{2}}" without seeing what
 * fills it. Catching a missing example here turns an opaque Graph 400 into a
 * message naming the placeholder the tenant still has to fill in.
 */
function collectBodyExamples(template: MessageTemplateRecord): string[] {
  const positions = templatePositions(template.body);
  if (positions.length === 0) return [];

  const byPosition = new Map(
    template.variables.map((variable) => [variable.position, variable]),
  );

  return positions.map((position) => {
    const example = byPosition.get(position)?.example;
    if (!example) {
      throw new BadRequestException(
        `Placeholder {{${position}}} has no example value. Meta rejects a template it cannot see filled in — add an example for every placeholder before submitting.`,
      );
    }
    return example;
  });
}
