// Worker half of the tenant offboarding sweep.
//
// A failed run is warn-level for the same reason the transcript purge's is:
// data that should be gone is still here, which is a compliance concern rather
// than a stale metric. It is arguably worse here — the tenant explicitly asked
// to be erased and was told a date.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TENANT_PURGE_QUEUE } from './tenant-purge.queue';

@Processor(TENANT_PURGE_QUEUE)
export class TenantPurgeProcessor extends WorkerHost {
  constructor(
    private readonly lifecycle: TenantLifecycleService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const { purged } = await this.lifecycle.purgeDue();
    if (purged.length > 0) {
      this.logger.warn(
        `Tenant purge sweep erased ${purged.length} closed tenant(s): ${purged.join(', ')}`,
        TenantPurgeProcessor.name,
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.warn(
      `Tenant purge sweep failed (job ${job.id}) — closed tenants are still holding data past the date they were given: ${error.message}`,
      TenantPurgeProcessor.name,
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Tenant-purge worker connection error: ${error.message}`,
      error.stack,
      TenantPurgeProcessor.name,
    );
  }
}
