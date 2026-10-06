// Product shell (AlertingModule, T18): registers the repeatable BullMQ
// job on module init. Same idempotent-on-boot reasoning as
// StuckTicketCheckSchedulerService.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../core';
import {
  TOOL_SCOPE_VIOLATION_CHECK_JOB_NAME,
  TOOL_SCOPE_VIOLATION_CHECK_QUEUE,
  TOOL_SCOPE_VIOLATION_CHECK_SCHEDULER_ID,
} from './tool-scope-violation-check.queue';
import { registerJobSchedulerInBackground } from '../queue/register-job-scheduler';

@Injectable()
export class ToolScopeViolationCheckSchedulerService implements OnModuleInit {
  constructor(
    @InjectQueue(TOOL_SCOPE_VIOLATION_CHECK_QUEUE)
    private readonly queue: Queue,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    registerJobSchedulerInBackground(
      this.queue,
      TOOL_SCOPE_VIOLATION_CHECK_SCHEDULER_ID,
      { every: this.config.toolScopeViolationCheckIntervalMs },
      { name: TOOL_SCOPE_VIOLATION_CHECK_JOB_NAME },
    );
  }
}
