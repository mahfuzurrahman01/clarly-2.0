import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import { TranscriptPurgeSchedulerService } from './transcript-purge-scheduler.service';
import {
  TRANSCRIPT_PURGE_JOB_NAME,
  TRANSCRIPT_PURGE_SCHEDULER_ID,
} from './transcript-purge.queue';

describe('TranscriptPurgeSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = { purgeCheckIntervalMs: 86400000 } as AppConfigService;
    const scheduler = new TranscriptPurgeSchedulerService(queue, config);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      TRANSCRIPT_PURGE_SCHEDULER_ID,
      { every: 86400000 },
      { name: TRANSCRIPT_PURGE_JOB_NAME },
    );
  });
});
