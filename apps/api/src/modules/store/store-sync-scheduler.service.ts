// Feature 24 (Store Integrations): registers the repeatable store-sync sweep.
//
// `upsertJobScheduler` (BullMQ v5) keyed on a fixed id is idempotent across
// app restarts AND across replicas — the house pattern from
// `ShipmentPollSchedulerService` (F26/D5). Emphatically NOT `setInterval`,
// which this module used before and which runs once per replica, so job
// rows duplicated per replica instead of the sweep running once platform-wide.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core/config/app-config.service';
import {
  STORE_SYNC_QUEUE,
  STORE_SYNC_SCHEDULER_ID,
  STORE_SYNC_SWEEP_JOB,
} from './store-sync.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class StoreSyncSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(STORE_SYNC_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      STORE_SYNC_SCHEDULER_ID,
      { every: this.config.storeSyncIntervalMs },
      { name: STORE_SYNC_SWEEP_JOB },
    );
  }
}
