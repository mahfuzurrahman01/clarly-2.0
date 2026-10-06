// Feature 24 (Store Integrations): the write side of `store_sync_jobs`.
//
// The table, its RLS policy and its indexes shipped with migration 0052 and
// NOTHING EVER WROTE TO IT — so "when did my catalogue last sync, and did it
// work" had no answer anywhere in the product, and a sync that failed every
// cycle looked identical to one that had never been attempted.
//
// Tenant-scoped like every other write in this module: `withTenantTx` is what
// sets `app.tenant_id` and therefore what makes the table's RLS policy apply
// at all (the correction the F24 review forced on StoreConnectionService).
// The platform-wide sweep reads connections through the documented
// `runAdminQuery` carve-out and then re-enters `withTenantTx` here with the
// tenant from the connection row — it never writes a job outside a tenant.
//
// `products_updated` is populated for real: the sync path calls
// `CatalogService.upsertProductDetailed()`, whose `RETURNING xmax = 0` upsert
// reports insert-vs-update per product, so `StoreSyncService` can accumulate
// a genuine created/updated split instead of leaving this column at its
// column default. `products_synced` / `products_failed` carry the totals as
// before.
//
// Recording is best-effort by design: a failure to write the bookkeeping row
// must not fail, or even interrupt, the sync it is bookkeeping. Every method
// swallows and logs, and `start()` returns null, which the caller treats as
// "no job to update".
import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { storeSyncJobs } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { AppLoggerService } from '../core';
import type {
  SyncJobStatus,
  SyncJobType,
} from '../persistence/drizzle/store-sync-jobs.table';

/** Provider error strings are unbounded third-party text; the column is not. */
const MAX_ERROR_MESSAGE = 1000;

export interface StoreSyncJobRecord {
  id: string;
  storeConnectionId: string;
  jobType: string;
  status: SyncJobStatus;
  productsSynced: number;
  productsUpdated: number;
  productsFailed: number;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class StoreSyncJobService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Queues a job row. Written as `pending` (the table's own default, i.e.
   * "queued") so that a row left in that state is visible evidence the sweep
   * died between scheduling and starting a sync — the transition to `running`
   * is a separate call for exactly that reason.
   *
   * @returns the row id, or null if the row could not be written (see header).
   */
  async enqueue(
    tenantId: string,
    storeConnectionId: string,
    jobType: SyncJobType,
  ): Promise<string | null> {
    try {
      const rows = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .insert(storeSyncJobs)
            .values({
              tenantId,
              storeConnectionId,
              jobType,
              status: 'pending' satisfies SyncJobStatus,
            })
            .returning({ id: storeSyncJobs.id }),
        tenantId,
      );
      return rows[0]?.id ?? null;
    } catch (err) {
      this.logger.error(
        `Could not record a sync job for connection ${storeConnectionId}: ${err}`,
        'StoreSyncJobService',
      );
      return null;
    }
  }

  async markRunning(tenantId: string, jobId: string): Promise<void> {
    await this.patch(tenantId, jobId, {
      status: 'running',
      startedAt: new Date(),
    });
  }

  /**
   * `counts.warning` records a run that finished but is not a faithful
   * mirror of the store — today, a product sweep stopped at the page cap
   * (see StoreSyncService). It lands in `error_message` on a `completed`
   * row rather than flipping the status to `failed`: the products that were
   * synced are real, but a reader must not read the row as a clean success.
   */
  async markCompleted(
    tenantId: string,
    jobId: string,
    counts: {
      synced: number;
      updated: number;
      errors: number;
      warning?: string;
    },
  ): Promise<void> {
    await this.patch(tenantId, jobId, {
      status: 'completed',
      productsSynced: counts.synced,
      productsUpdated: counts.updated,
      productsFailed: counts.errors,
      completedAt: new Date(),
      ...(counts.warning
        ? { errorMessage: counts.warning.slice(0, MAX_ERROR_MESSAGE) }
        : {}),
    });
  }

  async markFailed(
    tenantId: string,
    jobId: string,
    message: string,
    counts: { synced: number; errors: number },
  ): Promise<void> {
    await this.patch(tenantId, jobId, {
      status: 'failed',
      productsSynced: counts.synced,
      productsFailed: counts.errors,
      errorMessage: message.slice(0, MAX_ERROR_MESSAGE),
      completedAt: new Date(),
    });
  }

  /**
   * The last sync attempt for one connection — what a tenant sees for "did
   * my catalogue sync?".
   *
   * Best-effort on the read side too (see header): this is bookkeeping
   * decoration on `GET /store/connections`, so a transient DB error here
   * reads as "no job recorded" rather than 500ing the connection list the
   * merchant actually asked for.
   */
  async findLatestForConnection(
    tenantId: string,
    storeConnectionId: string,
  ): Promise<StoreSyncJobRecord | null> {
    let rows: (typeof storeSyncJobs.$inferSelect)[];
    try {
      rows = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select()
            .from(storeSyncJobs)
            .where(
              and(
                eq(storeSyncJobs.tenantId, tenantId),
                eq(storeSyncJobs.storeConnectionId, storeConnectionId),
              ),
            )
            .orderBy(desc(storeSyncJobs.createdAt), desc(storeSyncJobs.id))
            .limit(1),
        tenantId,
      );
    } catch (err) {
      this.logger.error(
        `Could not read the latest sync job for connection ${storeConnectionId}: ${err}`,
        'StoreSyncJobService',
      );
      return null;
    }
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      storeConnectionId: row.storeConnectionId,
      jobType: row.jobType,
      status: row.status as SyncJobStatus,
      // `products_synced` / `products_updated` / `products_failed` are
      // nullable columns with a default; a row written before this service
      // existed would read null.
      productsSynced: row.productsSynced ?? 0,
      productsUpdated: row.productsUpdated ?? 0,
      productsFailed: row.productsFailed ?? 0,
      errorMessage: row.errorMessage,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
    };
  }

  private async patch(
    tenantId: string,
    jobId: string,
    set: Partial<typeof storeSyncJobs.$inferInsert>,
  ): Promise<void> {
    try {
      await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(storeSyncJobs)
            .set(set)
            .where(
              and(
                eq(storeSyncJobs.id, jobId),
                eq(storeSyncJobs.tenantId, tenantId),
              ),
            ),
        tenantId,
      );
    } catch (err) {
      this.logger.error(
        `Could not update sync job ${jobId}: ${err}`,
        'StoreSyncJobService',
      );
    }
  }
}
