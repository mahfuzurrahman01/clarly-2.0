// Worker half of the export. Two jobs share this queue: assembling a
// requested export, and the scheduled sweep that deletes expired bundles.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { DataExportService } from './data-export.service';
import {
  DATA_EXPORT_EXPIRY_JOB_NAME,
  DATA_EXPORT_JOB_NAME,
  DATA_EXPORT_QUEUE,
} from './data-export.queue';

interface AssembleJobData {
  tenantId: string;
  exportId: string;
}

@Processor(DATA_EXPORT_QUEUE)
export class DataExportProcessor extends WorkerHost {
  constructor(
    private readonly exports: DataExportService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<AssembleJobData>): Promise<void> {
    if (job.name === DATA_EXPORT_EXPIRY_JOB_NAME) {
      const { purged } = await this.exports.purgeExpired();
      if (purged > 0) {
        this.logger.log(
          `Deleted ${purged} expired data-export bundle(s).`,
          DataExportProcessor.name,
        );
      }
      return;
    }

    if (job.name !== DATA_EXPORT_JOB_NAME) return;
    await this.exports.runExport(job.data.tenantId, job.data.exportId);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    // The failure is already recorded on the export row, which is what the
    // tenant sees. This is for whoever has to work out why.
    this.logger.warn(
      `Data export job ${job.id} (${job.name}) failed: ${error.message}`,
      DataExportProcessor.name,
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `data-export worker connection error: ${error.message}`,
      error.stack,
      DataExportProcessor.name,
    );
  }
}
