import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import { AutoCloseSweepSchedulerService } from './auto-close-sweep-scheduler.service';
import {
  AUTO_CLOSE_SWEEP_JOB_NAME,
  AUTO_CLOSE_SWEEP_SCHEDULER_ID,
} from './auto-close-sweep.queue';

describe('AutoCloseSweepSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = { autoCloseCheckIntervalMs: 300000 } as AppConfigService;
    const scheduler = new AutoCloseSweepSchedulerService(queue, config);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      AUTO_CLOSE_SWEEP_SCHEDULER_ID,
      { every: 300000 },
      { name: AUTO_CLOSE_SWEEP_JOB_NAME },
    );
  });
});
