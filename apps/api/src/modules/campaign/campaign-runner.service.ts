// F19 (D2, D3, D4): what one queue job actually does.
//
// Two entry points, matching the queue's two job names:
//
//   launch(...)   — once per campaign. Re-runs the gates (a campaign
//                   scheduled on Tuesday for Friday can have had its template
//                   rejected on Wednesday), snapshots the segment into
//                   `campaign_recipients`, and moves the campaign to
//                   `sending`. A gate failure here means `failed` with a
//                   reason and ZERO messages sent.
//   runBatch(...) — CAMPAIGN_BATCH_SIZE recipients, sent sequentially, and
//                   self-chaining: the batch that finishes enqueues the next.
//
// The three ways a batch can end, and why each is what it is:
//
//   - DEFERRED  (CampaignDeferredError) — a Meta tier/throughput limit, or
//     another campaign holds this number's slot. The job is re-delayed
//     WITHOUT spending a BullMQ attempt and every untouched recipient is
//     still `pending`. Deferring is not dropping: the campaign stays
//     `sending` and finishes in the next window.
//   - PAUSED    (CampaignPausedError, or a per-batch gate that flipped) — the
//     campaign stops with its remaining recipients INTACT, and an admin
//     notification says how many are left. D3's question, answered: a send
//     that would exceed the cap queues; it does not partially send past it.
//   - COMPLETED — no `pending` recipients remain.
//
// The per-batch re-checks (template, and D4's revocable subset) are once per
// batch and not once per message on purpose: approval and number health are
// revocable, but re-reading them 50 times per batch buys nothing and costs a
// round trip per recipient.
import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { AppConfigService, AppLoggerService } from '../core';
import { NotificationService } from '../notifications/notification.service';
import { notificationContent } from '../notifications/notification-content';
import { campaignRecipients } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { MessageTemplateService } from '../templates/message-template.service';
import {
  CampaignEligibilityService,
  describeBlocks,
} from './campaign-eligibility.service';
import { CampaignRateLimiter } from './campaign-rate-limiter.service';
import { CampaignSendSchedulerService } from './campaign-send.scheduler.service';
import {
  CampaignSenderService,
  type CampaignSendContext,
} from './campaign-sender.service';
import {
  assertTemplateSendable,
  campaignCategory,
  CampaignTemplateGateError,
} from './campaign-template-gate';
import {
  CampaignDeferredError,
  CampaignNotSendingError,
  CampaignPausedError,
} from './campaign.errors';
import { CampaignService, type CampaignRecord } from './campaign.service';
import { SegmentResolverService } from './segment-resolver.service';
import { SegmentService } from './segment.service';

const CONTEXT = 'CampaignRunnerService';

/** How long a batch waits when another campaign holds this number's slot. Plus the processor's jitter. */
export const NUMBER_BUSY_DELAY_MS = 30_000;

@Injectable()
export class CampaignRunnerService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly campaigns: CampaignService,
    private readonly templates: MessageTemplateService,
    private readonly segments: SegmentService,
    private readonly resolver: SegmentResolverService,
    private readonly eligibility: CampaignEligibilityService,
    private readonly sender: CampaignSenderService,
    private readonly limiter: CampaignRateLimiter,
    private readonly sendScheduler: CampaignSendSchedulerService,
    private readonly notifications: NotificationService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * `scheduled -> sending`, exactly once. The snapshot (D1) happens here and
   * never again for this campaign: the recipient set must be immutable for
   * the rest of the send, or the denominator every count reconciles against
   * moves under them.
   */
  async launch(tenantId: string, campaignId: string): Promise<void> {
    const campaign = await this.campaigns.require(tenantId, campaignId);
    if (campaign.status !== 'scheduled') {
      throw new CampaignNotSendingError(campaign.status);
    }

    // Gate point 3: re-read and re-check. Failing here means `failed`, with
    // the reason kept verbatim, and zero messages sent.
    try {
      await this.campaigns.assertSendable(campaign);
    } catch (error) {
      const reason = describeError(error);
      await this.campaigns.markFailed(tenantId, campaignId, reason);
      await this.notify(campaign, 'failed', reason);
      this.logger.warn(
        `campaign ${campaignId} failed its launch gate: ${reason}`,
        CONTEXT,
      );
      return;
    }

    const segment = await this.segments.require(tenantId, campaign.segmentId);
    let recipientCount: number;
    try {
      ({ recipientCount } = await this.resolver.snapshot(
        tenantId,
        campaignId,
        segment.definition,
        this.config.campaignMaxRecipients,
      ));
    } catch (error) {
      // The snapshot is all-or-nothing (it throws inside withTenantTx, which
      // rolls the whole thing back), so there is never a partial recipient
      // set behind a `failed` campaign.
      const reason = describeError(error);
      await this.campaigns.markFailed(tenantId, campaignId, reason);
      await this.notify(campaign, 'failed', reason);
      return;
    }

    await this.campaigns.markSending(tenantId, campaignId, recipientCount);
    await this.sendScheduler.enqueueBatch(tenantId, campaignId, 0);
    this.logger.log(
      `campaign ${campaignId} launched with ${recipientCount} recipients`,
      CONTEXT,
    );
  }

  /**
   * One batch.
   *
   * @throws CampaignDeferredError — the processor re-delays the job without
   * spending an attempt; every recipient this batch did not reach is still
   * `pending`.
   * @throws CampaignNotSendingError — the campaign was paused or cancelled
   * between this job being queued and it running. Not an error: the state
   * machine is authoritative, the queue is not.
   */
  async runBatch(
    tenantId: string,
    campaignId: string,
    batch: number,
  ): Promise<void> {
    const campaign = await this.campaigns.require(tenantId, campaignId);
    if (campaign.status !== 'sending') {
      throw new CampaignNotSendingError(campaign.status);
    }

    // D3's concurrency semaphore: one campaign in flight per phone number.
    // Two campaigns on one number would jointly blow the tier.
    if (!(await this.limiter.acquireNumberSlot(campaign.phoneNumberId))) {
      throw new CampaignDeferredError(
        NUMBER_BUSY_DELAY_MS,
        `another campaign is in flight on number ${campaign.phoneNumberId}`,
      );
    }

    try {
      const context = await this.openBatch(campaign);
      if (!context) return;

      const recipientIds = await this.claimableRecipients(tenantId, campaignId);
      if (recipientIds.length === 0) {
        await this.campaigns.markCompleted(tenantId, campaignId);
        this.logger.log(`campaign ${campaignId} completed`, CONTEXT);
        return;
      }

      for (const recipientId of recipientIds) {
        try {
          await this.sender.sendOne(context, recipientId);
        } catch (error) {
          if (error instanceof CampaignPausedError) {
            await this.pauseForSender(campaign, error);
            return;
          }
          throw error;
        }
      }

      await this.sendScheduler.enqueueBatch(tenantId, campaignId, batch + 1);
    } finally {
      await this.limiter.releaseNumberSlot(campaign.phoneNumberId);
    }
  }

  /**
   * The once-per-batch gates (D2 point 4, D4's revocable subset), plus the
   * per-campaign facts the sender reuses for all 50 recipients.
   *
   * @returns null when a gate moved the campaign to a paused state — the
   * caller simply stops, leaving every recipient pending.
   */
  private async openBatch(
    campaign: CampaignRecord,
  ): Promise<CampaignSendContext | null> {
    const template = await this.templates.require(
      campaign.tenantId,
      campaign.templateId,
    );

    try {
      assertTemplateSendable(template, campaign.templateValues.length, {
        requireMarketingOptOut: true,
      });
    } catch (error) {
      if (!(error instanceof CampaignTemplateGateError)) throw error;
      const reason = describeError(error);
      await this.campaigns.markPaused(
        campaign.tenantId,
        campaign.id,
        'paused_template',
        reason,
      );
      await this.notify(campaign, 'paused_template', reason);
      return null;
    }

    const recheck = await this.eligibility.recheck({
      tenantId: campaign.tenantId,
      phoneNumberId: campaign.phoneNumberId,
      category: campaignCategory(template),
      recipientCount: campaign.recipientCount,
      templateWabaId: template.wabaId,
    });
    if (!recheck.eligible) {
      const reason = describeBlocks(recheck.blocks);
      // D3(a): the platform entitlement gate specifically pauses as a SPEND
      // pause — "a campaign is not a way around the billing gate" — while a
      // Meta-side block is its own state, because the two have different
      // fixes (upgrade the plan vs. fix the number with Meta).
      const status = recheck.blocks.some(
        (block) => block.reason === 'billing_blocked',
      )
        ? ('paused_spend_cap' as const)
        : ('paused_eligibility' as const);
      await this.campaigns.markPaused(
        campaign.tenantId,
        campaign.id,
        status,
        reason,
      );
      await this.notify(campaign, status, reason);
      return null;
    }

    const snapshot = await this.eligibility.tierSnapshot(
      campaign.tenantId,
      campaign.phoneNumberId,
    );

    return {
      tenantId: campaign.tenantId,
      campaignId: campaign.id,
      phoneNumberId: campaign.phoneNumberId,
      templateName: template.name,
      templateLanguage: template.language,
      templateBody: template.body,
      templateValues: campaign.templateValues,
      launchedBy: campaign.createdBy ?? null,
      messagingLimitTier: snapshot?.messagingLimitTier ?? null,
      qualityRating: snapshot?.qualityRating ?? null,
    } satisfies CampaignSendContext;
  }

  /**
   * The next recipients to attempt, ordered by id so a retried batch reads
   * the same rows in the same order (hitting
   * `campaign_recipients_campaign_status_id_idx`). Only ids: the sender
   * re-reads each row under its own transaction, because it is the CLAIM,
   * not this read, that decides who sends.
   */
  private async claimableRecipients(
    tenantId: string,
    campaignId: string,
  ): Promise<string[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: campaignRecipients.id })
          .from(campaignRecipients)
          .where(
            and(
              eq(campaignRecipients.tenantId, tenantId),
              eq(campaignRecipients.campaignId, campaignId),
              eq(campaignRecipients.status, 'pending'),
            ),
          )
          .orderBy(asc(campaignRecipients.id))
          .limit(this.config.campaignBatchSize),
      tenantId,
    );
    return rows.map((row) => row.id);
  }

  private async pauseForSender(
    campaign: CampaignRecord,
    error: CampaignPausedError,
  ): Promise<void> {
    const status =
      error.kind === 'template'
        ? ('paused_template' as const)
        : error.kind === 'eligibility'
          ? ('paused_eligibility' as const)
          : ('paused_spend_cap' as const);
    await this.campaigns.markPaused(
      campaign.tenantId,
      campaign.id,
      status,
      error.detail,
    );
    await this.notify(campaign, status, error.detail);
  }

  /**
   * One admin notification per pause, naming how many recipients are left —
   * which is the number the merchant needs to decide whether to raise the
   * cap, fix the template or cancel.
   *
   * `dedupKey` includes the status so a campaign that pauses twice for two
   * different reasons is two notifications, and a re-fired identical pause is
   * one.
   */
  private async notify(
    campaign: CampaignRecord,
    status: string,
    reason: string,
  ): Promise<void> {
    const remaining = await this.countPending(campaign.tenantId, campaign.id);
    await this.notifications.record({
      tenantId: campaign.tenantId,
      ...notificationContent.campaignPaused({
        campaignName: campaign.name,
        pauseStatus: status,
        reason,
        remaining,
      }),
      severity: status === 'failed' ? 'critical' : 'warning',
      entityType: 'campaign',
      entityId: campaign.id,
      dedupKey: `campaign_paused:${campaign.id}:${status}`,
    });
  }

  private async countPending(
    tenantId: string,
    campaignId: string,
  ): Promise<number> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: campaignRecipients.id })
          .from(campaignRecipients)
          .where(
            and(
              eq(campaignRecipients.tenantId, tenantId),
              eq(campaignRecipients.campaignId, campaignId),
              eq(campaignRecipients.status, 'pending'),
            ),
          ),
      tenantId,
    );
    return rows.length;
  }
}

/**
 * A Nest HttpException's payload is an object, not a string, so `.message`
 * alone loses the wording the gates went to the trouble of writing. This
 * keeps the merchant-facing sentence intact wherever it is stored.
 */
function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'getResponse' in error) {
    const response = (error as { getResponse: () => unknown }).getResponse();
    if (typeof response === 'string') return response;
    if (
      response &&
      typeof response === 'object' &&
      typeof (response as { message?: unknown }).message === 'string'
    ) {
      return (response as { message: string }).message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
