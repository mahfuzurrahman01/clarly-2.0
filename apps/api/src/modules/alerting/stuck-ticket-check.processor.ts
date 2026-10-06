// Product shell (AlertingModule, T4): the worker half of the repeatable
// sweep. A failed sweep does NOT create a ticket or otherwise touch
// customer-facing state — it's a read-only cross-tenant scan, so a
// failure just means this cycle's alerts are late, not lost (the next
// scheduled run re-scans and still catches every still-unclaimed ticket).
// Logging and letting BullMQ's own retry policy handle it is correct,
// same reasoning SummarizationProcessor already documents for its own
// non-critical-path failures.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { StuckTicketCheckService } from './stuck-ticket-check.service';
import { STUCK_TICKET_CHECK_QUEUE } from './stuck-ticket-check.queue';

@Processor(STUCK_TICKET_CHECK_QUEUE)
export class StuckTicketCheckProcessor extends WorkerHost {
  constructor(
    private readonly stuckTicketCheck: StuckTicketCheckService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const alerts = await this.stuckTicketCheck.checkAllTenants();
    if (alerts.length > 0) {
      this.logger.log(
        `Stuck-ticket sweep found ${alerts.length} unclaimed ticket(s) past threshold`,
        'StuckTicketCheckProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Stuck-ticket sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-scan`,
      'StuckTicketCheckProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Stuck-ticket-check worker connection error: ${error.message}`,
      error.stack,
      'StuckTicketCheckProcessor',
    );
  }
}
