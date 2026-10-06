// Registers the expired-bundle sweep on module init — same
// `upsertJobScheduler` idempotency reasoning as every other scheduler here.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  DATA_EXPORT_EXPIRY_JOB_NAME,
  DATA_EXPORT_EXPIRY_SCHEDULER_ID,
  DATA_EXPORT_QUEUE,
} from './data-export.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class DataExportExpirySchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(DATA_EXPORT_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      DATA_EXPORT_EXPIRY_SCHEDULER_ID,
      { every: this.config.purgeCheckIntervalMs },
      { name: DATA_EXPORT_EXPIRY_JOB_NAME },
    );
  }
}
