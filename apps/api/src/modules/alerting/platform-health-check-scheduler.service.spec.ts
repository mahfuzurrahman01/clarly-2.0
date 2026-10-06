import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import { PlatformHealthCheckSchedulerService } from './platform-health-check-scheduler.service';
import {
  PLATFORM_HEALTH_CHECK_JOB_NAME,
  PLATFORM_HEALTH_CHECK_SCHEDULER_ID,
} from './platform-health-check.queue';

describe('PlatformHealthCheckSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = {
      platformHealthCheckIntervalMs: 60000,
    } as AppConfigService;
    const scheduler = new PlatformHealthCheckSchedulerService(queue, config);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      PLATFORM_HEALTH_CHECK_SCHEDULER_ID,
      { every: 60000 },
      { name: PLATFORM_HEALTH_CHECK_JOB_NAME },
    );
  });
});
