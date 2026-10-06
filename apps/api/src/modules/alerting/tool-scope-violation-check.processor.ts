// Product shell (AlertingModule, T18): worker half of the tool-scope-
// violation sweep. Same failure-handling reasoning as
// StuckTicketCheckProcessor — read-only cross-tenant scan, a failed cycle
// just means this cycle's alerts are late, next scheduled run re-scans.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { ToolScopeViolationCheckService } from './tool-scope-violation-check.service';
import { TOOL_SCOPE_VIOLATION_CHECK_QUEUE } from './tool-scope-violation-check.queue';

@Processor(TOOL_SCOPE_VIOLATION_CHECK_QUEUE)
export class ToolScopeViolationCheckProcessor extends WorkerHost {
  constructor(
    private readonly toolScopeViolationCheck: ToolScopeViolationCheckService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const alerts = await this.toolScopeViolationCheck.checkAllTenants();
    if (alerts.length > 0) {
      this.logger.log(
        `Tool-scope-violation sweep found ${alerts.length} tenant(s) over threshold`,
        'ToolScopeViolationCheckProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Tool-scope-violation sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-scan`,
      'ToolScopeViolationCheckProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Tool-scope-violation-check worker connection error: ${error.message}`,
      error.stack,
      'ToolScopeViolationCheckProcessor',
    );
  }
}
