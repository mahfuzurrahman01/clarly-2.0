// RetentionModule (Feature 7, T16): registers the repeatable BullMQ job on
// module init — same `upsertJobScheduler` idempotency reasoning as every
// other scheduler in this codebase.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  TRANSCRIPT_PURGE_JOB_NAME,
  TRANSCRIPT_PURGE_QUEUE,
  TRANSCRIPT_PURGE_SCHEDULER_ID,
} from './transcript-purge.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class TranscriptPurgeSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(TRANSCRIPT_PURGE_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      TRANSCRIPT_PURGE_SCHEDULER_ID,
      { every: this.config.purgeCheckIntervalMs },
      { name: TRANSCRIPT_PURGE_JOB_NAME },
    );
  }
}
