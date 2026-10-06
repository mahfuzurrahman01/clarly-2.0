import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import { StuckTicketCheckSchedulerService } from './stuck-ticket-check-scheduler.service';
import {
  STUCK_TICKET_CHECK_JOB_NAME,
  STUCK_TICKET_CHECK_SCHEDULER_ID,
} from './stuck-ticket-check.queue';

describe('StuckTicketCheckSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = { stuckTicketCheckIntervalMs: 60000 } as AppConfigService;
    const scheduler = new StuckTicketCheckSchedulerService(queue, config);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      STUCK_TICKET_CHECK_SCHEDULER_ID,
      { every: 60000 },
      { name: STUCK_TICKET_CHECK_JOB_NAME },
    );
  });
});
