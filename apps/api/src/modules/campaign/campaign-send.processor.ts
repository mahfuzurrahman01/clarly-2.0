// F19 (D3, D7): the worker for the dedicated `campaign-send` queue.
//
// It is deliberately thin. Every decision about who to message, what to
// charge and when to stop lives in CampaignRunnerService; this file only
// translates the runner's three named outcomes into BullMQ's vocabulary:
//
//   CampaignDeferredError   -> job.moveToDelayed() + DelayedError
//                              BullMQ's documented manual delay, which
//                              re-queues WITHOUT spending a retry attempt.
//                              A rate-limit deferral must not eventually
//                              exhaust the job's attempts and strand a
//                              half-sent campaign — that would be a drop.
//   CampaignNotSendingError -> complete quietly. A queued batch that arrives
//                              after an operator paused or cancelled the
//                              campaign is expected traffic, not a failure.
//   anything else           -> a real failure. BullMQ retries with the
//                              queue's backoff; recipients are untouched and
//                              `pending`, so a retry resumes rather than
//                              double-sends (the sender claims each row
//                              before its Graph call).
//
// D7 rule 2: the worker is NOT an RLS exception. `tenantId` comes from the
// job payload and every query the runner makes opens a tenant context from
// it — trusted because only our own producer writes these payloads.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { AppLoggerService } from '../core';
import {
  CAMPAIGN_LAUNCH_JOB,
  CAMPAIGN_SEND_QUEUE,
  CAMPAIGN_WORKER_CONCURRENCY,
  campaignJobSchema,
  type CampaignJobData,
} from './campaign-send.queue';
import { CampaignRunnerService } from './campaign-runner.service';
import {
  CampaignDeferredError,
  CampaignNotSendingError,
} from './campaign.errors';

/** Spread simultaneous deferrals so every waiting campaign does not retry on the same millisecond. */
const JITTER_MS = 2_000;

@Processor(CAMPAIGN_SEND_QUEUE, { concurrency: CAMPAIGN_WORKER_CONCURRENCY })
export class CampaignSendProcessor extends WorkerHost {
  constructor(
    private readonly runner: CampaignRunnerService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<CampaignJobData>, token?: string): Promise<void> {
    const data = campaignJobSchema.parse(job.data);

    try {
      if (job.name === CAMPAIGN_LAUNCH_JOB) {
        await this.runner.launch(data.tenantId, data.campaignId);
      } else {
        await this.runner.runBatch(data.tenantId, data.campaignId, data.batch);
      }
    } catch (error) {
      if (error instanceof CampaignDeferredError) {
        return this.defer(job, token, error.delayMs, error.reason);
      }
      if (error instanceof CampaignNotSendingError) {
        this.logger.log(
          `campaign job ${job.id} stopped: campaign is "${error.status}"`,
          CampaignSendProcessor.name,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * A campaign that exhausts its retries is left in `sending` with its
   * recipients `pending` ON PURPOSE — nothing is dropped, and a resume picks
   * it back up. It is logged loudly so the operator finds out; inventing a
   * terminal state here would turn a transient outage into a cancelled
   * broadcast.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<CampaignJobData>, error: Error): void {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    this.logger.error(
      `campaign job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message} — ` +
        'the campaign stays sending with its remaining recipients pending; resume it once the cause is fixed',
      CampaignSendProcessor.name,
    );
  }

  private async defer(
    job: Job<CampaignJobData>,
    token: string | undefined,
    delayMs: number,
    reason: string,
  ): Promise<never> {
    const delay = delayMs + Math.floor(Math.random() * JITTER_MS);
    this.logger.log(
      `campaign job ${job.id} delayed ${delay}ms: ${reason}`,
      CampaignSendProcessor.name,
    );
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  }
}
