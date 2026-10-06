// F26 (Delivery Tracking): the worker that actually sends a proactive
// shipment update (D5).
//
// Separate from the poll worker on purpose: one slow BSP call must not stall
// a sweep, and a send that failed must retry with the claim row already held
// — which is what makes a retry unable to double-send a send that succeeded.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { DeliveryNotificationService } from './delivery-notification.service';
import {
  DELIVERY_NOTIFICATION_QUEUE,
  type DeliveryNotificationJobData,
} from './delivery-notification.queue';
import type { ShipmentStatus } from './ports/courier-connector.port';

@Processor(DELIVERY_NOTIFICATION_QUEUE)
export class DeliveryNotificationProcessor extends WorkerHost {
  constructor(
    private readonly notifications: DeliveryNotificationService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<DeliveryNotificationJobData>): Promise<void> {
    const { tenantId, shipmentId, status } = job.data;
    const result = await this.notifications.notify(
      tenantId,
      shipmentId,
      status as ShipmentStatus,
    );

    // A failed BSP send is the ONE outcome worth retrying, and the claim row
    // is already held, so throwing here is safe. Every other outcome is a
    // decision, not a fault: retrying it would re-run the gates and reach the
    // same conclusion.
    if (result.outcome === 'failed') {
      throw new Error(
        `sending the ${status} update for shipment ${shipmentId} failed: ${result.detail ?? 'unknown error'}`,
      );
    }

    this.logger.debug(
      `Shipment ${shipmentId} -> ${status}: ${result.outcome}`,
      'DeliveryNotificationProcessor',
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Delivery-notification job ${job?.id ?? '(unknown)'} failed: ${error.message}`,
      'DeliveryNotificationProcessor',
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Delivery-notification worker connection error: ${error.message}`,
      error.stack,
      'DeliveryNotificationProcessor',
    );
  }
}
