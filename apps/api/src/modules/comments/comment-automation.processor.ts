// Gulf T8 (D11): the worker for the dedicated comment-automation queue.
//
// Two kinds of "not now", both DELAYED rather than failed or dropped:
//   - the tenant already has COMMENT_TENANT_CONCURRENCY comments in flight
//     (per-tenant concurrency on a shared queue), and
//   - CommentDeferredError from the pipeline (the Instagram private-reply
//     limiter, or Meta throttling us).
// Both use BullMQ's documented manual delay: `job.moveToDelayed(ts, token)`
// followed by `throw new DelayedError()`, which re-queues the job without
// spending one of its retry attempts.
//
// Anything else is a real failure: BullMQ retries it with backoff (the queue's
// default job options), and when the attempts run out the comment is marked
// skipped with `job_failed` so the ledger never shows it as pending forever.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { AppLoggerService } from '../core';
import {
  COMMENT_AUTOMATION_QUEUE,
  COMMENT_WORKER_CONCURRENCY,
  commentAutomationJobSchema,
  type CommentAutomationJobData,
} from './comment-automation.queue';
import { CommentAutomationService } from './comment-automation.service';
import { CommentLedgerService } from './comment-ledger.service';
import { CommentRateLimiter } from './comment-rate-limiter.service';
import { CommentDeferredError } from './comment.errors';

/** Wait before retrying a tenant that is at its concurrency limit, plus jitter so waiters do not stampede. */
export const TENANT_BUSY_DELAY_MS = 5_000;
const JITTER_MS = 2_000;

@Processor(COMMENT_AUTOMATION_QUEUE, {
  concurrency: COMMENT_WORKER_CONCURRENCY,
})
export class CommentAutomationProcessor extends WorkerHost {
  constructor(
    private readonly automation: CommentAutomationService,
    private readonly limiter: CommentRateLimiter,
    private readonly ledger: CommentLedgerService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(
    job: Job<CommentAutomationJobData>,
    token?: string,
  ): Promise<void> {
    const data = commentAutomationJobSchema.parse(job.data);

    if (!(await this.limiter.acquireTenantSlot(data.tenantId))) {
      return this.defer(job, token, TENANT_BUSY_DELAY_MS, 'tenant busy');
    }
    try {
      await this.automation.handle(data.tenantId, data.commentEventId);
    } catch (error) {
      if (error instanceof CommentDeferredError) {
        return this.defer(job, token, error.delayMs, error.reason);
      }
      throw error;
    } finally {
      await this.limiter.releaseTenantSlot(data.tenantId);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<CommentAutomationJobData>,
    error: Error,
  ): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    const parsed = commentAutomationJobSchema.safeParse(job.data);
    this.logger.error(
      `comment automation job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`,
      CommentAutomationProcessor.name,
    );
    if (!parsed.success) return;
    try {
      await this.ledger.skip(
        parsed.data.tenantId,
        parsed.data.commentEventId,
        'job_failed',
      );
    } catch (skipError) {
      this.logger.error(
        `could not mark comment ${parsed.data.commentEventId} as failed: ${
          skipError instanceof Error ? skipError.message : String(skipError)
        }`,
        CommentAutomationProcessor.name,
      );
    }
  }

  private async defer(
    job: Job<CommentAutomationJobData>,
    token: string | undefined,
    delayMs: number,
    reason: string,
  ): Promise<never> {
    const delay = delayMs + Math.floor(Math.random() * JITTER_MS);
    this.logger.log(
      `comment automation job ${job.id} delayed ${delay}ms: ${reason}`,
      CommentAutomationProcessor.name,
    );
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  }
}
