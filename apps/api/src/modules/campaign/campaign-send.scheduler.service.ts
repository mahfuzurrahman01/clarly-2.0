// F19 (D3, D8): the producer half of the campaign-send queue — it decides
// WHEN a campaign's work enters the queue, never what the work is.
//
// A deliberate deviation from D8's sketch, which described a repeatable
// sweep that "picks up `scheduled` campaigns whose time has come": that
// sweep would have to scan `campaigns` across every tenant, and D7 bans
// `runAdminQuery` in this module outright — there is no platform-level query
// in this feature. A BullMQ DELAYED job keyed on the campaign id does the
// same job with no cross-tenant read at all: Redis persists it across
// restarts, `campaignLaunchJobId()` makes a re-schedule idempotent, and
// removing the job is how a cancel un-schedules.
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppLoggerService, Clock } from '../core';
import {
  CAMPAIGN_BATCH_JOB,
  CAMPAIGN_LAUNCH_JOB,
  CAMPAIGN_SEND_QUEUE,
  campaignBatchJobId,
  campaignLaunchJobId,
  type CampaignJobData,
} from './campaign-send.queue';

const CONTEXT = 'CampaignSendSchedulerService';

@Injectable()
export class CampaignSendSchedulerService {
  constructor(
    @InjectQueue(CAMPAIGN_SEND_QUEUE) private readonly queue: Queue,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Queues the launch. `at` in the past (or absent) means "now" — a merchant
   * pressing Send is the same operation as a schedule whose time has come.
   */
  async scheduleLaunch(
    tenantId: string,
    campaignId: string,
    at: Date | null,
  ): Promise<void> {
    const delay = Math.max(
      0,
      (at?.getTime() ?? 0) - this.clock.now().getTime(),
    );
    await this.queue.add(
      CAMPAIGN_LAUNCH_JOB,
      { tenantId, campaignId, batch: 0 } satisfies CampaignJobData,
      { jobId: campaignLaunchJobId(campaignId), delay },
    );
  }

  /**
   * Removes a launch that has not fired yet. Best-effort: a job that has
   * already started is not removable, and the processor's own
   * `status === 'sending'` guard is what stops it in that case — the state
   * machine is authoritative, the queue is not.
   */
  async cancelScheduledLaunch(campaignId: string): Promise<void> {
    try {
      await this.queue.remove(campaignLaunchJobId(campaignId));
    } catch (error) {
      this.logger.warn(
        `could not remove the scheduled launch for campaign ${campaignId}: ${
          error instanceof Error ? error.message : String(error)
        } — the campaign's own status still stops it`,
        CONTEXT,
      );
    }
  }

  /** Enqueues the next batch. `delayMs` carries a rate-limit deferral forward. */
  async enqueueBatch(
    tenantId: string,
    campaignId: string,
    batch: number,
    delayMs = 0,
  ): Promise<void> {
    await this.queue.add(
      CAMPAIGN_BATCH_JOB,
      { tenantId, campaignId, batch } satisfies CampaignJobData,
      { jobId: campaignBatchJobId(campaignId, batch), delay: delayMs },
    );
  }
}
