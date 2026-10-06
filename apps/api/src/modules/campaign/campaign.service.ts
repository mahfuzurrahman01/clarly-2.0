// F19 (D2, D3, D8): campaign authoring AND the operator half of the
// lifecycle — schedule, pause, resume, cancel.
//
// The state machine, in one place so it cannot be two:
//
//   draft ──schedule──► scheduled ──(launch job fires)──► sending
//     │                    │                                │
//     │                    │                     ┌──────────┼──────────┐
//     │                    │                     ▼          ▼          ▼
//     │                    │            paused_spend_cap  paused_   paused_
//     │                    │            paused_manual     template  eligibility
//     │                    │                     └──────resume──────┘ │
//     │                    │                                │◄────────┘
//     └──────cancel────────┴──────cancel───────────────────┴──► canceled
//                                                          └──► completed
//                                        (launch-time gate fails) ──► failed
//
// Every arrow that starts a send re-runs the SAME two gates — D2's template
// check and D4's eligibility check — because both are revocable: a template
// approved on Tuesday can be rejected on Wednesday, and Meta can restrict a
// number at any time. `assertSendable()` is the single place that pairing
// lives.
//
// Nothing here ever drops a recipient. A pause leaves every remaining
// recipient `pending`; a cancel terminates each one with an explicit
// `skipped / canceled`. That is exit criterion 2, and `cancel()`'s UPDATE is
// what makes it a database fact rather than an intention.
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppConfigService, Clock } from '../core';
import {
  campaignRecipients,
  campaigns,
  type CampaignStatus,
  type CampaignTemplateValue,
  type NotificationKind,
} from '../persistence/drizzle/schema';
import type { DrizzleDb } from '../persistence/persistence.providers';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { MessageTemplateService } from '../templates/message-template.service';
import {
  CampaignEligibilityService,
  describeBlocks,
  type EligibilityBlock,
} from './campaign-eligibility.service';
import { estimateCampaignCostUsd } from './campaign-pricing';
import { CampaignSendSchedulerService } from './campaign-send.scheduler.service';
import {
  assertTemplateSendable,
  campaignCategory,
} from './campaign-template-gate';
import { SegmentResolverService } from './segment-resolver.service';
import { SegmentService } from './segment.service';

/**
 * Re-exported so the first slice's import path keeps working. The rules
 * themselves live in `campaign-template-gate.ts` — one copy, four callers
 * (authoring, schedule, launch, per batch).
 */
export { CampaignTemplateGateError } from './campaign-template-gate';

/** What a resume or a cancel makes untrue: "this campaign is paused". */
const PAUSE_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'campaign_paused',
];

export interface CampaignRecord {
  id: string;
  tenantId: string;
  name: string;
  segmentId: string;
  templateId: string;
  templateValues: CampaignTemplateValue[];
  phoneNumberId: string;
  status: CampaignStatus;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  recipientCount: number;
  estimatedCostUsd: number;
  spendCapUsd: number;
  spentUsd: number;
  pauseReason: string | null;
  failureReason: string | null;
  /** The person who launched it — D6 records every campaign message as theirs. */
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCampaignInput {
  name: string;
  segmentId: string;
  templateId: string;
  templateValues: CampaignTemplateValue[];
  phoneNumberId: string;
  spendCapUsd?: number;
  createdBy?: string | null;
}

export type UpdateCampaignInput = Partial<
  Pick<
    CreateCampaignInput,
    'name' | 'segmentId' | 'templateId' | 'templateValues' | 'phoneNumberId'
  >
> & { spendCapUsd?: number };

/** Every status from which a paused or scheduled campaign can be started (or restarted). */
export const PAUSED_STATUSES: readonly CampaignStatus[] = [
  'paused_spend_cap',
  'paused_template',
  'paused_manual',
  'paused_eligibility',
];

/** Once a campaign is in one of these, nothing moves it again. */
export const TERMINAL_STATUSES: readonly CampaignStatus[] = [
  'completed',
  'canceled',
  'failed',
];

/**
 * The pre-flight spend refusal (D3). A 422 carrying the three numbers the
 * merchant needs to decide between raising the cap and narrowing the
 * segment — never a bare "too expensive".
 */
export class CampaignSpendCapExceededError extends UnprocessableEntityException {
  constructor(
    readonly estimatedCostUsd: number,
    readonly spendCapUsd: number,
  ) {
    super({
      message:
        `This campaign is estimated to cost $${estimatedCostUsd.toFixed(2)}, ` +
        `over its $${spendCapUsd.toFixed(2)} spend cap. Raise the cap to at least ` +
        `$${estimatedCostUsd.toFixed(2)} or narrow the segment.`,
      estimatedCostUsd,
      spendCapUsd,
      requiredCapUsd: estimatedCostUsd,
    });
  }
}

/** D4's gate, refused at the door. The FULL block list, so a merchant fixes everything in one trip. */
export class CampaignNotEligibleError extends UnprocessableEntityException {
  constructor(readonly blocks: EligibilityBlock[]) {
    super({
      message: describeBlocks(blocks),
      blocks: blocks.map((block) => ({
        reason: block.reason,
        message: block.message,
      })),
    });
  }
}

/** A lifecycle verb applied to a status it does not apply to. 409, naming both. */
export class CampaignStateError extends ConflictException {
  constructor(action: string, status: CampaignStatus) {
    super(`Cannot ${action} a campaign that is "${status}".`);
  }
}

@Injectable()
export class CampaignService {
  constructor(
    // The first three positions are the first slice's contract — `create()`
    // uses only these, and its spec constructs the service positionally.
    private readonly tenantContext: TenantContextService,
    private readonly templates: MessageTemplateService,
    private readonly segments: SegmentService,
    private readonly eligibility: CampaignEligibilityService,
    private readonly resolver: SegmentResolverService,
    private readonly sendScheduler: CampaignSendSchedulerService,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {}

  async create(
    tenantId: string,
    input: CreateCampaignInput,
  ): Promise<CampaignRecord> {
    // 404s a segment/template this tenant cannot see BEFORE any write —
    // same reasoning as CustomerLabelController.requireCustomer(): the
    // composite FK already stops the dangerous version of this at the DB
    // layer, but a raw FK-violation 500 is not an acceptable answer.
    await this.segments.require(tenantId, input.segmentId);
    const template = await this.templates.require(tenantId, input.templateId);
    // Gate point 1 of 4. The opt-out-instruction requirement starts at
    // schedule, so the first slice's `POST /campaigns` contract is unchanged.
    assertTemplateSendable(template, input.templateValues.length);

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(campaigns)
          .values({
            tenantId,
            name: input.name,
            segmentId: input.segmentId,
            templateId: input.templateId,
            templateValues: input.templateValues,
            phoneNumberId: input.phoneNumberId,
            spendCapUsd:
              input.spendCapUsd ?? this.config.campaignDefaultSpendCapUsd,
            createdBy: input.createdBy ?? null,
          })
          .returning(),
      tenantId,
    );
    return toRecord(row);
  }

  /** Draft only (D8): a campaign that has been scheduled or sent is a historical record. */
  async update(
    tenantId: string,
    id: string,
    input: UpdateCampaignInput,
  ): Promise<CampaignRecord> {
    const campaign = await this.require(tenantId, id);
    if (campaign.status !== 'draft') {
      throw new CampaignStateError('edit', campaign.status);
    }

    const segmentId = input.segmentId ?? campaign.segmentId;
    const templateId = input.templateId ?? campaign.templateId;
    const templateValues = input.templateValues ?? campaign.templateValues;
    await this.segments.require(tenantId, segmentId);
    const template = await this.templates.require(tenantId, templateId);
    assertTemplateSendable(template, templateValues.length);

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(campaigns)
          .set({
            name: input.name ?? campaign.name,
            segmentId,
            templateId,
            templateValues,
            phoneNumberId: input.phoneNumberId ?? campaign.phoneNumberId,
            spendCapUsd: input.spendCapUsd ?? campaign.spendCapUsd,
            updatedAt: this.clock.now(),
          })
          .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, tenantId)))
          .returning(),
      tenantId,
    );
    return toRecord(row);
  }

  async get(tenantId: string, id: string): Promise<CampaignRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, tenantId)))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async require(tenantId: string, id: string): Promise<CampaignRecord> {
    const campaign = await this.get(tenantId, id);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }
    return campaign;
  }

  async list(
    tenantId: string,
    options: { limit: number; offset: number },
  ): Promise<{ campaigns: CampaignRecord[]; total: number }> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(campaigns)
          .where(eq(campaigns.tenantId, tenantId))
          .orderBy(desc(campaigns.createdAt))
          .limit(options.limit)
          .offset(options.offset),
      tenantId,
    );
    return { campaigns: rows.map(toRecord), total: rows.length };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * `POST /campaigns/:id/schedule`. `at` in the past (or absent) means "send
   * now" — pressing Send and scheduling for a time that has arrived are the
   * same operation, so they are not two code paths.
   *
   * Everything expensive or refusable happens HERE, on the merchant's
   * screen: the template gate, a live segment preview, the cost estimate
   * against the cap, and D4's eligibility check including the tier-span
   * rule. A campaign that is going to be refused is refused before a single
   * recipient row exists.
   */
  async schedule(
    tenantId: string,
    id: string,
    at: Date | null,
  ): Promise<CampaignRecord> {
    const campaign = await this.require(tenantId, id);
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new CampaignStateError('schedule', campaign.status);
    }

    const { estimatedCostUsd } = await this.assertSendable(campaign);

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(campaigns)
          .set({
            status: 'scheduled',
            scheduledAt: at,
            estimatedCostUsd,
            pauseReason: null,
            failureReason: null,
            updatedAt: this.clock.now(),
          })
          .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, tenantId)))
          .returning(),
      tenantId,
    );

    // The queue is told only AFTER the row says `scheduled`, so a launch job
    // that fires immediately never finds a campaign that is still a draft.
    await this.sendScheduler.scheduleLaunch(tenantId, id, at);
    return toRecord(row);
  }

  /** `POST /campaigns/:id/pause`. Recipients are left exactly as they are — pausing is not cancelling. */
  async pause(tenantId: string, id: string): Promise<CampaignRecord> {
    const campaign = await this.require(tenantId, id);
    if (campaign.status !== 'sending' && campaign.status !== 'scheduled') {
      throw new CampaignStateError('pause', campaign.status);
    }
    if (campaign.status === 'scheduled') {
      await this.sendScheduler.cancelScheduledLaunch(id);
    }
    return this.setStatus(tenantId, id, 'paused_manual', {
      pauseReason: 'Paused from the console.',
    });
  }

  /**
   * `POST /campaigns/:id/resume`. Re-runs the full gate — eligibility,
   * template, spend cap — before anything moves, because the reason it
   * paused may still be true, and because time has passed either way.
   */
  async resume(tenantId: string, id: string): Promise<CampaignRecord> {
    const campaign = await this.require(tenantId, id);
    if (!PAUSED_STATUSES.includes(campaign.status)) {
      throw new CampaignStateError('resume', campaign.status);
    }

    await this.assertSendable(campaign);

    const resumed = await this.setStatus(
      tenantId,
      id,
      'sending',
      { pauseReason: null },
      PAUSE_NOTIFICATION_KINDS,
    );
    // The recipient snapshot already exists, so this resumes the send at the
    // next batch rather than re-launching (which would re-snapshot).
    await this.sendScheduler.enqueueBatch(tenantId, id, this.nextBatchToken());
    return resumed;
  }

  /**
   * `POST /campaigns/:id/cancel`. EVERY remaining recipient is terminated
   * with `skipped / canceled` in the same transaction that marks the
   * campaign canceled — so the invariant "after a terminal campaign state,
   * zero recipients are pending or sending" holds as a database fact, not as
   * a convention the sender is trusted to honour.
   */
  async cancel(tenantId: string, id: string): Promise<CampaignRecord> {
    const campaign = await this.require(tenantId, id);
    if (TERMINAL_STATUSES.includes(campaign.status)) {
      throw new CampaignStateError('cancel', campaign.status);
    }

    await this.sendScheduler.cancelScheduledLaunch(id);
    const now = this.clock.now();

    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({ status: 'skipped', skipReason: 'canceled', updatedAt: now })
        .where(
          and(
            eq(campaignRecipients.tenantId, tenantId),
            eq(campaignRecipients.campaignId, id),
            inArray(campaignRecipients.status, ['pending', 'sending']),
          ),
        );

      const rows = await tx
        .update(campaigns)
        .set({
          status: 'canceled',
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, tenantId)))
        .returning();
      await this.retireNotifications(
        tx,
        tenantId,
        id,
        PAUSE_NOTIFICATION_KINDS,
        now,
      );
      return rows;
    }, tenantId);

    return toRecord(row);
  }

  // ---------------------------------------------------------------------
  // Transitions the send path drives. Kept here so `campaigns.status` has
  // exactly one writer.
  // ---------------------------------------------------------------------

  /**
   * The two revocable gates, run together. Used by schedule, by resume and
   * by the launch job — the three places a send can start.
   *
   * @returns the live recipient estimate the caller stores on the campaign.
   */
  async assertSendable(
    campaign: CampaignRecord,
  ): Promise<{ recipientCount: number; estimatedCostUsd: number }> {
    const template = await this.templates.require(
      campaign.tenantId,
      campaign.templateId,
    );
    assertTemplateSendable(template, campaign.templateValues.length, {
      requireMarketingOptOut: true,
    });

    const segment = await this.segments.require(
      campaign.tenantId,
      campaign.segmentId,
    );
    const { count } = await this.resolver.preview(
      campaign.tenantId,
      segment.definition,
    );

    if (count > this.config.campaignMaxRecipients) {
      throw new UnprocessableEntityException(
        `This segment resolves to ${count} recipients, over the ${this.config.campaignMaxRecipients} per-campaign cap. Narrow the segment.`,
      );
    }

    // Already-spent money counts against the cap on a resume, so a campaign
    // cannot be resumed into overspending what it has left.
    const estimatedCostUsd = estimateCampaignCostUsd(count);
    if (estimatedCostUsd + campaign.spentUsd > campaign.spendCapUsd) {
      throw new CampaignSpendCapExceededError(
        estimatedCostUsd + campaign.spentUsd,
        campaign.spendCapUsd,
      );
    }

    const eligibility = await this.eligibility.check({
      tenantId: campaign.tenantId,
      phoneNumberId: campaign.phoneNumberId,
      category: campaignCategory(template),
      recipientCount: count,
      // D2 bullet 5: enforced by the eligibility gate, which is the only
      // place that reads the sending number's own WABA id.
      templateWabaId: template.wabaId,
    });
    if (!eligibility.eligible) {
      throw new CampaignNotEligibleError(eligibility.blocks);
    }

    return { recipientCount: count, estimatedCostUsd };
  }

  /** `scheduled -> sending`, with the snapshot's recipient count written in the same statement. */
  async markSending(
    tenantId: string,
    id: string,
    recipientCount: number,
  ): Promise<void> {
    const now = this.clock.now();
    await this.setStatus(tenantId, id, 'sending', {
      recipientCount,
      startedAt: now,
      pauseReason: null,
      failureReason: null,
    });
  }

  /** A pause the sender decided on. Remaining recipients are deliberately untouched. */
  async markPaused(
    tenantId: string,
    id: string,
    status: Extract<
      CampaignStatus,
      'paused_spend_cap' | 'paused_template' | 'paused_eligibility'
    >,
    reason: string,
  ): Promise<void> {
    await this.setStatus(tenantId, id, status, { pauseReason: reason });
  }

  /** No `pending` recipients left. The natural end of a send. */
  async markCompleted(tenantId: string, id: string): Promise<void> {
    await this.setStatus(tenantId, id, 'completed', {
      completedAt: this.clock.now(),
      pauseReason: null,
    });
  }

  /** A launch-time gate failure: ZERO messages sent, and the reason kept verbatim. */
  async markFailed(
    tenantId: string,
    id: string,
    reason: string,
  ): Promise<void> {
    await this.setStatus(tenantId, id, 'failed', {
      failureReason: reason,
      completedAt: this.clock.now(),
    });
  }

  /**
   * `retire` names notification kinds the new status makes stale (see
   * `retireNotifications`); they are marked read in the same transaction.
   */
  private async setStatus(
    tenantId: string,
    id: string,
    status: CampaignStatus,
    extra: Partial<typeof campaigns.$inferInsert> = {},
    retire: readonly NotificationKind[] = [],
  ): Promise<CampaignRecord> {
    const now = this.clock.now();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(campaigns)
        .set({ ...extra, status, updatedAt: now })
        .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, tenantId)))
        .returning();
      if (rows.length > 0) {
        await this.retireNotifications(tx, tenantId, id, retire, now);
      }
      return rows;
    }, tenantId);
    if (!row) throw new NotFoundException(`Campaign ${id} not found`);
    return toRecord(row);
  }

  /**
   * QA 2026-10-05: "Campaign X paused" stays on the bell after the merchant
   * resumed or canceled it unless something retires it. Done here, in the
   * transaction of the transition that made it untrue.
   */
  private async retireNotifications(
    tx: DrizzleDb,
    tenantId: string,
    campaignId: string,
    kinds: readonly NotificationKind[],
    readAt: Date,
  ): Promise<void> {
    if (kinds.length === 0) return;
    await markEntityNotificationsRead(tx, {
      tenantId,
      entityType: 'campaign',
      entityIds: [campaignId],
      kinds,
      readAt,
    });
  }

  /**
   * A fresh batch token for a resumed campaign. Batch numbers only have to
   * be unique per campaign (they are part of the BullMQ job id, and BullMQ
   * ignores an add whose id already exists), so a coarse clock-derived token
   * is enough and needs no extra column.
   */
  private nextBatchToken(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }
}

function toRecord(row: typeof campaigns.$inferSelect): CampaignRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    segmentId: row.segmentId,
    templateId: row.templateId,
    templateValues: row.templateValues,
    phoneNumberId: row.phoneNumberId,
    status: row.status,
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    recipientCount: row.recipientCount,
    estimatedCostUsd: row.estimatedCostUsd,
    spendCapUsd: row.spendCapUsd,
    spentUsd: row.spentUsd,
    pauseReason: row.pauseReason,
    failureReason: row.failureReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Kept exported: the stats service and the runner both need "is this still a live send?". */
export function isTerminal(status: CampaignStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
