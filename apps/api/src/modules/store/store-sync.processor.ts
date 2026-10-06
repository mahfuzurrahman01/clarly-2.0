// Feature 24 (Store Integrations): the worker half of the store-sync sweep.
//
// Triggered by the repeatable `sweep` job `StoreSyncSchedulerService`
// registers via `upsertJobScheduler`, not a JS `setInterval` — the interval
// used to run once per replica, so every replica queued its own
// `store_sync_jobs` row for the same connection on the same cycle. BullMQ's
// scheduler runs the repeatable job once platform-wide regardless of replica
// count; only one worker instance picks it up.
//
// A failed connection sync is logged and does not stop the sweep from
// syncing the rest — the same reasoning the old `setInterval` loop used, just
// with the trigger mechanism swapped out.
//
// The sweep lists tenants (TenantDirectoryService) and reads each tenant's
// active connections under that tenant. It used to read every active
// connection platform-wide via `runAdminQuery`, which under FORCE RLS and a
// NOBYPASSRLS role returned nothing, so no store was ever synced (Clarly 2.0).
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService, sweepTenantsWithBoundedConcurrency } from '../core';
import { TenantDirectoryService } from '../tenant-context/tenant-directory';
import { StoreConnectionService } from './store-connection.service';
import { StoreSyncService } from './store-sync.service';
import { STORE_SYNC_QUEUE } from './store-sync.queue';

@Processor(STORE_SYNC_QUEUE)
export class StoreSyncProcessor extends WorkerHost {
  constructor(
    private readonly syncService: StoreSyncService,
    private readonly connectionService: StoreConnectionService,
    private readonly tenants: TenantDirectoryService,
    private readonly appLogger: AppLoggerService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const tenantIds = await this.tenants.listTenantIds();
    // Sequential within a tenant (provider rate limits are per store/account),
    // bounded across tenants; one tenant's failure never stops the rest.
    await sweepTenantsWithBoundedConcurrency(
      tenantIds,
      async (tenantId) => {
        const connections =
          await this.connectionService.findActiveByTenant(tenantId);
        for (const conn of connections) {
          try {
            await this.syncService.syncConnection(conn);
          } catch (err) {
            this.appLogger.error(
              `Failed to sync connection ${conn.id} (${conn.provider}): ${err}`,
              'StoreSyncProcessor',
            );
          }
        }
        return connections.length;
      },
      { logger: this.appLogger, sweepName: 'store-sync' },
    );
  }

  // Without this, a Redis blip is an unhandled EventEmitter 'error' —
  // @nestjs/bullmq attaches no default listener — which crashes the process
  // instead of degrading this one queue.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.appLogger.error(
      `Store-sync worker connection error: ${error.message}`,
      error.stack,
      'StoreSyncProcessor',
    );
  }
}
