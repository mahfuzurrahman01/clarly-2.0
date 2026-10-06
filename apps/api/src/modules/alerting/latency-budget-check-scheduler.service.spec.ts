import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import { LatencyBudgetCheckSchedulerService } from './latency-budget-check-scheduler.service';
import {
  LATENCY_BUDGET_CHECK_JOB_NAME,
  LATENCY_BUDGET_CHECK_SCHEDULER_ID,
} from './latency-budget-check.queue';

describe('LatencyBudgetCheckSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = { latencyCheckIntervalMs: 60000 } as AppConfigService;
    const scheduler = new LatencyBudgetCheckSchedulerService(queue, config);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      LATENCY_BUDGET_CHECK_SCHEDULER_ID,
      { every: 60000 },
      { name: LATENCY_BUDGET_CHECK_JOB_NAME },
    );
  });
});
