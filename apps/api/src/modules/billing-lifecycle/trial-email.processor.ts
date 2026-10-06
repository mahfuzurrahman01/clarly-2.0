// Product shell (BillingLifecycleModule, Lane A item 10): the worker half
// of the repeatable trial-email sweep. Same "a failed sweep is late, never
// lost — the next scheduled run re-evaluates from scratch" posture as
// LatencyBudgetCheckProcessor/StuckTicketCheckProcessor.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { TrialEmailService } from './trial-email.service';
import { TRIAL_EMAIL_CHECK_QUEUE } from './trial-email.queue';

@Processor(TRIAL_EMAIL_CHECK_QUEUE)
export class TrialEmailCheckProcessor extends WorkerHost {
  constructor(
    private readonly trialEmail: TrialEmailService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const result = await this.trialEmail.sweep();
    if (result.trialEndingEmailed > 0 || result.trialExpiredEmailed > 0) {
      this.logger.log(
        `trial-email sweep: ${result.trialEndingEmailed} trial-ending, ${result.trialExpiredEmailed} trial-expired`,
        'TrialEmailCheckProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `trial-email sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-evaluate`,
      'TrialEmailCheckProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `trial-email-check worker connection error: ${error.message}`,
      error.stack,
      'TrialEmailCheckProcessor',
    );
  }
}
