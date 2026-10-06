// F24 follow-up: the sync sweep used to be a raw `setInterval`, so a
// multi-replica deployment fanned out one sweep per replica. This pins that
// `upsertJobScheduler` is called once, keyed on a fixed scheduler id, with
// the same interval the old `setInterval` used.
import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core/config/app-config.service';
import { StoreSyncSchedulerService } from './store-sync-scheduler.service';
import {
  STORE_SYNC_SCHEDULER_ID,
  STORE_SYNC_SWEEP_JOB,
} from './store-sync.queue';

describe('StoreSyncSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = { storeSyncIntervalMs: 900_000 } as AppConfigService;
    const scheduler = new StoreSyncSchedulerService(queue, config);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      STORE_SYNC_SCHEDULER_ID,
      { every: 900_000 },
      { name: STORE_SYNC_SWEEP_JOB },
    );
  });
});
