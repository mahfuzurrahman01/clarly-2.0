// F25 D1.4: registers the repeatable sweep on module init.
//
// `upsertJobScheduler` (BullMQ v5) is idempotent on the scheduler id — safe to
// call on every boot, including every replica, without accumulating duplicate
// repeat schedules. Same shape as `StuckTicketCheckSchedulerService`; this is
// not a new scheduling mechanism.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  ORDER_EXPIRY_INTERVAL_MS,
  ORDER_EXPIRY_JOB_NAME,
  ORDER_EXPIRY_QUEUE,
  ORDER_EXPIRY_SCHEDULER_ID,
} from './order-expiry.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class OrderExpirySchedulerService implements OnModuleInit {
  constructor(@InjectQueue(ORDER_EXPIRY_QUEUE) private readonly queue: Queue) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      ORDER_EXPIRY_SCHEDULER_ID,
      { every: ORDER_EXPIRY_INTERVAL_MS },
      { name: ORDER_EXPIRY_JOB_NAME },
    );
  }
}
