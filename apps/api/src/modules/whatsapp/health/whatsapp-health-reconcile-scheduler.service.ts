// Channel (WhatsappHealthModule, Gulf T5 / D5): registers the repeatable
// health-reconcile job on module init. Same `upsertJobScheduler` idempotency
// as every other scheduler in this codebase (MetaTokenRefreshSchedulerService).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../../core';
import {
  WHATSAPP_HEALTH_RECONCILE_JOB_NAME,
  WHATSAPP_HEALTH_RECONCILE_QUEUE,
  WHATSAPP_HEALTH_RECONCILE_SCHEDULER_ID,
} from './whatsapp-health-reconcile.queue';
import { registerJobSchedulerInBackground } from '../../queue/register-job-scheduler';

@Injectable()
export class WhatsappHealthReconcileSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(WHATSAPP_HEALTH_RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      WHATSAPP_HEALTH_RECONCILE_SCHEDULER_ID,
      { every: this.config.whatsappHealthReconcileIntervalMs },
      { name: WHATSAPP_HEALTH_RECONCILE_JOB_NAME },
    );
  }
}
