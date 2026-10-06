// Product shell (AlertingModule, T18): registers the repeatable BullMQ
// job on module init. Same idempotent-on-boot reasoning as
// StuckTicketCheckSchedulerService.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  PLATFORM_HEALTH_CHECK_JOB_NAME,
  PLATFORM_HEALTH_CHECK_QUEUE,
  PLATFORM_HEALTH_CHECK_SCHEDULER_ID,
} from './platform-health-check.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class PlatformHealthCheckSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(PLATFORM_HEALTH_CHECK_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      PLATFORM_HEALTH_CHECK_SCHEDULER_ID,
      { every: this.config.platformHealthCheckIntervalMs },
      { name: PLATFORM_HEALTH_CHECK_JOB_NAME },
    );
  }
}
