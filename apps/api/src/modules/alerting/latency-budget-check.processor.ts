// Product shell (AlertingModule, T9): the worker half of the repeatable
// p95 sweep. Same non-critical-path failure reasoning as
// StuckTicketCheckProcessor (T4) — a failed sweep is a read-only
// aggregate query, so a failure just means this cycle's alerts are late,
// never lost (the next scheduled run re-aggregates a fresh window).
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { LatencyBudgetCheckService } from './latency-budget-check.service';
import { LATENCY_BUDGET_CHECK_QUEUE } from './latency-budget-check.queue';

@Processor(LATENCY_BUDGET_CHECK_QUEUE)
export class LatencyBudgetCheckProcessor extends WorkerHost {
  constructor(
    private readonly latencyBudgetCheck: LatencyBudgetCheckService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const alerts = await this.latencyBudgetCheck.checkAllTenants();
    if (alerts.length > 0) {
      this.logger.log(
        `Latency-budget sweep found ${alerts.length} tenant(s) over their p95 budget`,
        'LatencyBudgetCheckProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Latency-budget sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-aggregate`,
      'LatencyBudgetCheckProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Latency-budget-check worker connection error: ${error.message}`,
      error.stack,
      'LatencyBudgetCheckProcessor',
    );
  }
}
