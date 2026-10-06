import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import { ToolScopeViolationCheckSchedulerService } from './tool-scope-violation-check-scheduler.service';
import {
  TOOL_SCOPE_VIOLATION_CHECK_JOB_NAME,
  TOOL_SCOPE_VIOLATION_CHECK_SCHEDULER_ID,
} from './tool-scope-violation-check.queue';

describe('ToolScopeViolationCheckSchedulerService', () => {
  it('registers an idempotent repeat scheduler using the configured interval', async () => {
    const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = {
      toolScopeViolationCheckIntervalMs: 60000,
    } as AppConfigService;
    const scheduler = new ToolScopeViolationCheckSchedulerService(
      queue,
      config,
    );

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      TOOL_SCOPE_VIOLATION_CHECK_SCHEDULER_ID,
      { every: 60000 },
      { name: TOOL_SCOPE_VIOLATION_CHECK_JOB_NAME },
    );
  });
});
