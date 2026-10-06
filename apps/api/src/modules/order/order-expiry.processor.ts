// F25 D1.4: the worker half of the approval-window sweep.
//
// A failed sweep does not touch customer-facing state — it is a bounded scan
// of pending orders, so a failure means this cycle's expiries are late, not
// lost; the next scheduled run re-scans and still catches every overdue order.
// Same reasoning `StuckTicketCheckProcessor` already records.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { ORDER_EXPIRY_QUEUE } from './order-expiry.queue';
import { OrderExpiryService } from './order-expiry.service';

@Processor(ORDER_EXPIRY_QUEUE)
export class OrderExpiryProcessor extends WorkerHost {
  constructor(
    private readonly expiry: OrderExpiryService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const expired = await this.expiry.sweepAllTenants();
    if (expired > 0) {
      this.logger.log(
        `Order approval-window sweep expired ${expired} pending order(s)`,
        'OrderExpiryProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Order expiry sweep job ${job?.id ?? '(unknown)'} failed: ${error.message} — next scheduled run will re-scan`,
      'OrderExpiryProcessor',
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Order-expiry worker connection error: ${error.message}`,
      error.stack,
      'OrderExpiryProcessor',
    );
  }
}
