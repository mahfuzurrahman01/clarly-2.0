// OutcomesModule (Feature 7, A9): registers the repeatable BullMQ job on
// module init — same `upsertJobScheduler` idempotency reasoning as
// AlertingModule's schedulers.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  AUTO_CLOSE_SWEEP_JOB_NAME,
  AUTO_CLOSE_SWEEP_QUEUE,
  AUTO_CLOSE_SWEEP_SCHEDULER_ID,
} from './auto-close-sweep.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class AutoCloseSweepSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(AUTO_CLOSE_SWEEP_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      AUTO_CLOSE_SWEEP_SCHEDULER_ID,
      { every: this.config.autoCloseCheckIntervalMs },
      { name: AUTO_CLOSE_SWEEP_JOB_NAME },
    );
  }
}
