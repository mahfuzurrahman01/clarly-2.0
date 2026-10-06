// F26 (Delivery Tracking): the worker half of the poll queue (D5).
//
// Two job names on one worker: the repeatable `sweep` and the targeted
// `refresh` that `track_order` enqueues when stored state is stale. Both end
// in `ShipmentPollService`, so there is one poll implementation, not two.
//
// A failed poll touches no customer-facing state — the next sweep re-selects
// the same shipments, because `last_polled_at` only moves on a SUCCESSFUL
// read. Logging and letting BullMQ retry is correct, the same reasoning
// StuckTicketCheckProcessor documents.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { ShipmentPollService } from './shipment-poll.service';
import {
  SHIPMENT_POLL_QUEUE,
  SHIPMENT_POLL_REFRESH_JOB,
  type ShipmentRefreshJobData,
} from './shipment-poll.queue';

@Processor(SHIPMENT_POLL_QUEUE)
export class ShipmentPollProcessor extends WorkerHost {
  constructor(
    private readonly poll: ShipmentPollService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<Partial<ShipmentRefreshJobData>>): Promise<void> {
    if (job.name === SHIPMENT_POLL_REFRESH_JOB && !job.data?.tenantId) {
      // Enqueued by a build before refresh jobs carried their tenant. The
      // shipments cannot be read without one; the scheduled sweep will poll
      // them anyway.
      this.logger.warn(
        `Shipment refresh job ${job.id ?? '(unknown)'} has no tenantId — skipped, the sweep will cover it`,
        'ShipmentPollProcessor',
      );
      return;
    }
    const outcome =
      job.name === SHIPMENT_POLL_REFRESH_JOB
        ? await this.poll.refresh(
            job.data.tenantId as string,
            job.data?.shipmentIds ?? [],
          )
        : await this.poll.sweep();

    if (outcome.shipmentsPolled > 0 || outcome.connectionsFailed > 0) {
      this.logger.log(
        `Shipment ${job.name}: polled ${outcome.shipmentsPolled}, ${outcome.statusChanges} status change(s), ${outcome.connectionsFailed} connection failure(s)`,
        'ShipmentPollProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Shipment poll job ${job?.id ?? '(unknown)'} failed: ${error.message} — the next scheduled sweep will re-select these shipments`,
      'ShipmentPollProcessor',
    );
  }

  // Without this, a Redis blip is an unhandled EventEmitter 'error' —
  // @nestjs/bullmq attaches no default listener — which crashes the process
  // instead of degrading this one queue.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Shipment-poll worker connection error: ${error.message}`,
      error.stack,
      'ShipmentPollProcessor',
    );
  }
}
