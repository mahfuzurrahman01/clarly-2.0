// F26 (Delivery Tracking): registers the repeatable poll sweep (D5).
//
// `upsertJobScheduler` (BullMQ v5) keyed on a fixed id is idempotent across
// app restarts AND across replicas — the house pattern from
// `stuck-ticket-check-scheduler.service.ts`. Emphatically NOT `setInterval`,
// which F24's store sync used and which runs once per replica, multiplying
// every courier call by the instance count.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  SHIPMENT_POLL_QUEUE,
  SHIPMENT_POLL_SCHEDULER_ID,
  SHIPMENT_POLL_SWEEP_JOB,
} from './shipment-poll.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class ShipmentPollSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(SHIPMENT_POLL_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      SHIPMENT_POLL_SCHEDULER_ID,
      { every: this.config.shipmentPollIntervalMs },
      { name: SHIPMENT_POLL_SWEEP_JOB },
    );
  }
}
