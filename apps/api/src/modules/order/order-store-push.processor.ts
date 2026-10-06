// F25 D4: the worker half of the asynchronous store push.
//
// Thin by design, exactly like `StuckTicketCheckProcessor`: the decisions live
// in `OrderStorePushService`, and this class only translates an outcome into
// "BullMQ should retry" or "BullMQ should not".
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { OrderStorePushService } from './order-store-push.service';
import {
  ORDER_STORE_PUSH_QUEUE,
  type OrderStorePushJobData,
} from './order-store-push.queue';

@Processor(ORDER_STORE_PUSH_QUEUE)
export class OrderStorePushProcessor extends WorkerHost {
  constructor(
    private readonly push: OrderStorePushService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<OrderStorePushJobData>): Promise<void> {
    const outcome = await this.push.push(job.data.tenantId, job.data.orderId);

    // THROWING is how a retry is requested — the queue's own bounded backoff
    // is the retry mechanism, and the service has already recorded the attempt
    // and the error on the row.
    if (outcome === 'retryable_failure') {
      throw new Error(
        `Store push for order ${job.data.orderId} failed; retrying.`,
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<OrderStorePushJobData> | undefined, error: Error): void {
    // The ORDER is unaffected: it is `confirmed` and the customer has been
    // told. Only `store_sync_status` moves, and the service raises the
    // `order_store_push_failed` notification once attempts are exhausted.
    this.logger.warn(
      `Order store-push job ${job?.id ?? '(unknown)'} failed: ${error.message}`,
      'OrderStorePushProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener —
  // which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Order store-push worker connection error: ${error.message}`,
      error.stack,
      'OrderStorePushProcessor',
    );
  }
}
