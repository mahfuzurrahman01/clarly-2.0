// Product shell (AlertingModule, T9): registers the repeatable BullMQ job
// on module init — same `upsertJobScheduler` idempotency reasoning as
// StuckTicketCheckSchedulerService (T4).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  LATENCY_BUDGET_CHECK_JOB_NAME,
  LATENCY_BUDGET_CHECK_QUEUE,
  LATENCY_BUDGET_CHECK_SCHEDULER_ID,
} from './latency-budget-check.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class LatencyBudgetCheckSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(LATENCY_BUDGET_CHECK_QUEUE) private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      LATENCY_BUDGET_CHECK_SCHEDULER_ID,
      { every: this.config.latencyCheckIntervalMs },
      { name: LATENCY_BUDGET_CHECK_JOB_NAME },
    );
  }
}
