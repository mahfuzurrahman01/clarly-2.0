// F26 (Delivery Tracking): the enqueue half of the notification path (D5).
//
// Both producers — the poll sweep and the J&T webhook — go through here, so
// "a status changed" and "a customer is told" stay one hop apart and the job
// id is minted in exactly one place.
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppLoggerService } from '../core';
import {
  DELIVERY_NOTIFICATION_JOB,
  DELIVERY_NOTIFICATION_QUEUE,
  type DeliveryNotificationJobData,
} from './delivery-notification.queue';
import type { ShipmentStatus } from './ports/courier-connector.port';

@Injectable()
export class DeliveryNotificationQueueService {
  constructor(
    @InjectQueue(DELIVERY_NOTIFICATION_QUEUE) private readonly queue: Queue,
    private readonly logger: AppLoggerService,
  ) {}

  async enqueue(
    tenantId: string,
    shipmentId: string,
    status: ShipmentStatus,
  ): Promise<void> {
    try {
      await this.queue.add(
        DELIVERY_NOTIFICATION_JOB,
        { tenantId, shipmentId, status } satisfies DeliveryNotificationJobData,
        {
          // (shipment, status) is the same key the claim row uses, so a poll
          // and a webhook observing the same transition collapse to one job
          // before they even reach the claim. The claim is still the
          // authority — this only saves the second job the work.
          jobId: `shipment:${shipmentId}:${status}`,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      this.logger.error(
        `could not enqueue the ${status} notification for shipment ${shipmentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'DeliveryNotificationQueueService',
      );
    }
  }
}
