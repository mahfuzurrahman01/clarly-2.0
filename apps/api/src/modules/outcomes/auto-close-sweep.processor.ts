// OutcomesModule (Feature 7, A9): worker half of the repeatable sweep.
// Same non-critical-path failure reasoning as AlertingModule's sweeps — a
// failed pass just means some conversations get their outcome recorded a
// cycle late, never lost (a conversation still quiet next sweep gets
// caught then).
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { AutoCloseSweepService } from './auto-close-sweep.service';
import { AUTO_CLOSE_SWEEP_QUEUE } from './auto-close-sweep.queue';

@Processor(AUTO_CLOSE_SWEEP_QUEUE)
export class AutoCloseSweepProcessor extends WorkerHost {
  constructor(
    private readonly autoCloseSweep: AutoCloseSweepService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const closed = await this.autoCloseSweep.sweepAllTenants();
    if (closed.length > 0) {
      this.logger.log(
        `Auto-close sweep recorded ${closed.length} never-escalated conversation(s) as resolved`,
        'AutoCloseSweepProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Auto-close sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will retry`,
      'AutoCloseSweepProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Auto-close-sweep worker connection error: ${error.message}`,
      error.stack,
      'AutoCloseSweepProcessor',
    );
  }
}
