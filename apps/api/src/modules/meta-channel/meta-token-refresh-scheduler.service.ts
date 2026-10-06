// Channel (MetaChannelModule, Feature 16): registers the repeatable
// token-refresh job on module init — same `upsertJobScheduler` idempotency
// reasoning as every other scheduler in this codebase.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  META_TOKEN_REFRESH_JOB_NAME,
  META_TOKEN_REFRESH_QUEUE,
  META_TOKEN_REFRESH_SCHEDULER_ID,
} from './meta-token-refresh.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class MetaTokenRefreshSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(META_TOKEN_REFRESH_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      META_TOKEN_REFRESH_SCHEDULER_ID,
      { every: this.config.metaTokenRefreshIntervalMs },
      { name: META_TOKEN_REFRESH_JOB_NAME },
    );
  }
}
