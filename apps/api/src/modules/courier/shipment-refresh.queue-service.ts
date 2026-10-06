// F26 (Delivery Tracking): the enqueue half of D4's "answer from stored
// state, refresh in the background".
//
// A separate, tiny service rather than injecting the Queue into
// `TrackOrderExecutor` for one reason: the executor is on the respond path,
// and the respond path must not be able to fail because Redis hiccupped. The
// enqueue is swallowed and logged here, in one place, so every caller gets
// the same "best effort" guarantee instead of each remembering to wrap it.
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppLoggerService } from '../core';
import {
  SHIPMENT_POLL_QUEUE,
  SHIPMENT_POLL_REFRESH_JOB,
  type ShipmentRefreshJobData,
} from './shipment-poll.queue';

@Injectable()
export class ShipmentRefreshQueueService {
  constructor(
    @InjectQueue(SHIPMENT_POLL_QUEUE) private readonly queue: Queue,
    private readonly logger: AppLoggerService,
  ) {}

  async enqueueRefresh(tenantId: string, shipmentIds: string[]): Promise<void> {
    if (shipmentIds.length === 0) return;
    try {
      await this.queue.add(
        SHIPMENT_POLL_REFRESH_JOB,
        { tenantId, shipmentIds } satisfies ShipmentRefreshJobData,
        {
          // Deduplicated per shipment set: a customer asking "where is my
          // order" three times in a minute must not queue three courier
          // calls. The next sweep would pick these up anyway.
          jobId: `refresh:${tenantId}:${[...shipmentIds].sort().join(',')}`,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      this.logger.warn(
        `could not enqueue a shipment refresh for ${shipmentIds.length} shipment(s): ${
          error instanceof Error ? error.message : String(error)
        } — the scheduled sweep will still pick them up`,
        'ShipmentRefreshQueueService',
      );
    }
  }
}
