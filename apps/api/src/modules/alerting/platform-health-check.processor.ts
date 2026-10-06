// Product shell (AlertingModule, T18): worker half of the platform-health
// sweep. Same failure-handling reasoning as StuckTicketCheckProcessor —
// read-only cross-cutting scan, a failed cycle just means this cycle's
// alerts are late, next scheduled run catches any still-active condition.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { PlatformHealthCheckService } from './platform-health-check.service';
import { PLATFORM_HEALTH_CHECK_QUEUE } from './platform-health-check.queue';

@Processor(PLATFORM_HEALTH_CHECK_QUEUE)
export class PlatformHealthCheckProcessor extends WorkerHost {
  constructor(
    private readonly platformHealthCheck: PlatformHealthCheckService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const alerts = await this.platformHealthCheck.checkAll();
    if (alerts.length > 0) {
      this.logger.log(
        `Platform-health sweep fired ${alerts.length} alert(s)`,
        'PlatformHealthCheckProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Platform-health sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-check`,
      'PlatformHealthCheckProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Platform-health-check worker connection error: ${error.message}`,
      error.stack,
      'PlatformHealthCheckProcessor',
    );
  }
}
