// Registers the repeatable sweep on module init — same `upsertJobScheduler`
// idempotency reasoning as every other scheduler in this codebase.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  TENANT_PURGE_JOB_NAME,
  TENANT_PURGE_QUEUE,
  TENANT_PURGE_SCHEDULER_ID,
} from './tenant-purge.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class TenantPurgeSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(TENANT_PURGE_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    // Shares the transcript purge's interval: both are daily housekeeping and
    // a second knob for the same cadence would be a config surface nobody
    // wants to reason about.
    registerJobSchedulerInBackground(
      this.queue,
      TENANT_PURGE_SCHEDULER_ID,
      { every: this.config.purgeCheckIntervalMs },
      { name: TENANT_PURGE_JOB_NAME },
    );
  }
}
