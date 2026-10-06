// DunningEmailCheckProcessor: worker half of the repeatable dunning-email
// sweep. Same posture as TrialEmailCheckProcessor — a failed sweep is late,
// never lost; the next scheduled run re-evaluates from scratch.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { DunningEmailService } from './dunning-email.service';
import { DUNNING_EMAIL_CHECK_QUEUE } from './dunning-email.queue';

@Processor(DUNNING_EMAIL_CHECK_QUEUE)
export class DunningEmailCheckProcessor extends WorkerHost {
  constructor(
    private readonly dunningEmail: DunningEmailService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const result = await this.dunningEmail.sweep();
    if (result.dunningEmailed > 0) {
      this.logger.log(
        `dunning-email sweep: ${result.dunningEmailed} past-due tenant(s) emailed`,
        'DunningEmailCheckProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `dunning-email sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-evaluate`,
      'DunningEmailCheckProcessor',
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `dunning-email-check worker connection error: ${error.message}`,
      error.stack,
      'DunningEmailCheckProcessor',
    );
  }
}
