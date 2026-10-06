// DunningEmailCheckSchedulerService: registers the repeatable BullMQ job on
// module init — same upsertJobScheduler idempotency reasoning as every other
// scheduler in the codebase.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  DUNNING_EMAIL_CHECK_JOB_NAME,
  DUNNING_EMAIL_CHECK_QUEUE,
  DUNNING_EMAIL_CHECK_SCHEDULER_ID,
} from './dunning-email.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class DunningEmailCheckSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(DUNNING_EMAIL_CHECK_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      DUNNING_EMAIL_CHECK_SCHEDULER_ID,
      { every: this.config.trialEmailCheckIntervalMs },
      { name: DUNNING_EMAIL_CHECK_JOB_NAME },
    );
  }
}
