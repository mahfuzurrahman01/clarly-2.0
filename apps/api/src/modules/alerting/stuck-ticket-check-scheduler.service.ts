// Product shell (AlertingModule, T4): registers the repeatable BullMQ job
// on module init. `upsertJobScheduler` (BullMQ v5) is idempotent on
// `STUCK_TICKET_CHECK_SCHEDULER_ID` — safe to call on every app boot
// (including every replica in a multi-instance deployment) without
// accumulating duplicate repeat schedules, unlike the older
// `queue.add(..., { repeat })` API this replaces.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  STUCK_TICKET_CHECK_JOB_NAME,
  STUCK_TICKET_CHECK_QUEUE,
  STUCK_TICKET_CHECK_SCHEDULER_ID,
} from './stuck-ticket-check.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class StuckTicketCheckSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(STUCK_TICKET_CHECK_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      STUCK_TICKET_CHECK_SCHEDULER_ID,
      { every: this.config.stuckTicketCheckIntervalMs },
      { name: STUCK_TICKET_CHECK_JOB_NAME },
    );
  }
}
