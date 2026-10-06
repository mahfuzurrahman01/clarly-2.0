// Product shell (BillingLifecycleModule, Lane A item 10): registers the
// repeatable BullMQ job on module init — same `upsertJobScheduler`
// idempotency reasoning as every other AlertingModule-style scheduler.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  TRIAL_EMAIL_CHECK_JOB_NAME,
  TRIAL_EMAIL_CHECK_QUEUE,
  TRIAL_EMAIL_CHECK_SCHEDULER_ID,
} from './trial-email.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class TrialEmailCheckSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(TRIAL_EMAIL_CHECK_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      TRIAL_EMAIL_CHECK_SCHEDULER_ID,
      { every: this.config.trialEmailCheckIntervalMs },
      { name: TRIAL_EMAIL_CHECK_JOB_NAME },
    );
  }
}
