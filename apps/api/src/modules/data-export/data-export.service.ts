// Requesting, tracking, and serving a tenant's data export.
//
// The assembly itself lives in DataExportAssemblerService and runs on a queue;
// this service owns the record's lifecycle and the download.
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, lte, inArray } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  AppConfigService,
  AppLoggerService,
  sweepTenantsWithBoundedConcurrency,
} from '../core';
import { dataExports } from '../persistence/drizzle/schema';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantDirectoryService } from '../tenant-context/tenant-directory';
import { DataExportAssemblerService } from './data-export-assembler.service';
import type { DataExportRecord } from './data-export.dto';
import { DATA_EXPORT_JOB_NAME, DATA_EXPORT_QUEUE } from './data-export.queue';

const MS_PER_DAY = 86_400_000;

/** Statuses that mean an export is still coming. A second request while one of these is outstanding is refused rather than queued behind it. */
const IN_FLIGHT = ['pending', 'running'] as const;

/**
 * How long an in-flight export may sit before it is treated as abandoned.
 *
 * The in-flight guard below is the only thing standing between an impatient
 * console and a dozen full-table scans — but on its own it is also a trap: a
 * job lost to a worker crash, a Redis flush, or a queue pointed at the wrong
 * database leaves a row stuck at `pending` forever, and a tenant who can
 * never request another export can never exercise their Article 15 right
 * again without someone editing the database by hand. An export that has
 * gone this long without reaching `ready` or `failed` is not in flight, it
 * is gone, and the next request is allowed to replace it.
 *
 * An hour is far past any real assembly (a full workspace takes seconds) and
 * far short of a person's patience.
 */
const STALE_IN_FLIGHT_MS = 3_600_000;

@Injectable()
export class DataExportService {
  constructor(
    @InjectQueue(DATA_EXPORT_QUEUE) private readonly queue: Queue,
    private readonly tenantContext: TenantContextService,
    private readonly tenants: TenantDirectoryService,
    private readonly assembler: DataExportAssemblerService,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Queues an export.
   *
   * Refuses while one is already in flight. Not a nicety: assembling an export
   * reads every row a tenant owns, and a console that retries on a slow
   * response would otherwise let one impatient admin queue a dozen full-table
   * scans against their own workspace.
   */
  async request(
    tenantId: string,
    requestedBy: string,
  ): Promise<DataExportRecord> {
    const existing = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(dataExports)
          .where(
            and(
              eq(dataExports.tenantId, tenantId),
              inArray(dataExports.status, [...IN_FLIGHT]),
            ),
          )
          .limit(1),
      tenantId,
    );
    if (existing[0]) {
      const startedAt = existing[0].createdAt.getTime();
      if (Date.now() - startedAt < STALE_IN_FLIGHT_MS) {
        throw new ConflictException(
          'An export is already being prepared for this workspace. Wait for it to finish before requesting another.',
        );
      }

      // Recorded as failed rather than deleted: the tenant asked for this
      // export and is owed an answer about what became of it.
      this.logger.warn(
        `data export ${existing[0].id} for tenant ${tenantId} was still "${existing[0].status}" after ${STALE_IN_FLIGHT_MS}ms — marking it failed and allowing a new request. Its worker never finished; check the queue.`,
        DataExportService.name,
      );
      await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(dataExports)
            .set({
              status: 'failed',
              error:
                'Preparation never finished — the export was abandoned and superseded by a newer request.',
            })
            .where(eq(dataExports.id, existing[0].id)),
        tenantId,
      );
    }

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(dataExports)
          .values({ tenantId, requestedBy, status: 'pending' })
          .returning(),
      tenantId,
    );

    await this.queue.add(DATA_EXPORT_JOB_NAME, {
      tenantId,
      exportId: row.id,
    });

    return toRecord(row);
  }

  async list(tenantId: string): Promise<DataExportRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(dataExports)
          .where(eq(dataExports.tenantId, tenantId))
          .orderBy(desc(dataExports.createdAt))
          .limit(50),
      tenantId,
    );
    return rows.map(toRecord);
  }

  async get(tenantId: string, exportId: string): Promise<DataExportRecord> {
    const row = await this.findRow(tenantId, exportId);
    if (!row) throw new NotFoundException(`Export ${exportId} not found`);
    return toRecord(row);
  }

  /** The bundle bytes. 409 rather than 404 when it is not ready — the export exists, it is just not finished. */
  async download(
    tenantId: string,
    exportId: string,
  ): Promise<{ content: Buffer; filename: string }> {
    const row = await this.findRow(tenantId, exportId);
    if (!row) throw new NotFoundException(`Export ${exportId} not found`);

    if (row.status !== 'ready' || !row.storageKey) {
      throw new ConflictException(
        `This export is ${row.status}, not ready to download.`,
      );
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      // The sweep may not have run yet, but an expired bundle must not be
      // served just because its row is still here.
      throw new ConflictException(
        'This export has expired. Request a new one.',
      );
    }

    return {
      content: await this.storage.download(row.storageKey),
      filename: `export-${exportId}.json`,
    };
  }

  /** Called by the processor. Assembles, stores, and stamps the row ready — or records why it failed. */
  async runExport(tenantId: string, exportId: string): Promise<void> {
    await this.setStatus(tenantId, exportId, { status: 'running' });

    try {
      const { content, rowCounts } = await this.assembler.assemble(tenantId);
      const stored = await this.storage.upload(
        tenantId,
        `data-export-${exportId}.json`,
        content,
      );

      await this.setStatus(tenantId, exportId, {
        status: 'ready',
        storageKey: stored.storageKey,
        sizeBytes: String(stored.sizeBytes),
        rowCounts,
        completedAt: new Date(),
        expiresAt: new Date(
          Date.now() + this.config.dataExportTtlDays * MS_PER_DAY,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Recorded on the row, not just logged: an export that silently never
      // finishes leaves a tenant waiting on a legal obligation with no idea
      // anything went wrong.
      await this.setStatus(tenantId, exportId, {
        status: 'failed',
        error: message,
        completedAt: new Date(),
      });
      this.logger.error(
        `Data export ${exportId} for tenant ${tenantId} failed: ${message}`,
        DataExportService.name,
      );
      throw error;
    }
  }

  /**
   * Deletes expired bundles from storage.
   *
   * The row survives with its counts, so a tenant can still see that an export
   * happened and when — only the copy of their data goes. Platform
   * housekeeping, run tenant by tenant.
   */
  async purgeExpired(now: Date = new Date()): Promise<{ purged: number }> {
    // Per tenant, under its own transaction: `data_exports` is FORCE RLS, so
    // a platform-wide read returned nothing and no expired bundle was ever
    // deleted (fixed in Clarly 2.0). Closed workspaces are included — their
    // export copies must expire too.
    const tenantIds = await this.tenants.listTenantIds({ includeClosed: true });
    const perTenant = await sweepTenantsWithBoundedConcurrency(
      tenantIds,
      (tenantId) =>
        this.tenantContext.withTenantTx(
          (tx) =>
            tx
              .select({
                id: dataExports.id,
                tenantId: dataExports.tenantId,
                storageKey: dataExports.storageKey,
              })
              .from(dataExports)
              .where(
                and(
                  eq(dataExports.tenantId, tenantId),
                  isNotNull(dataExports.storageKey),
                  isNotNull(dataExports.expiresAt),
                  lte(dataExports.expiresAt, now),
                ),
              ),
          tenantId,
        ),
      { logger: this.logger, sweepName: 'data-export-purge' },
    );
    const due = perTenant.flatMap((result) => result.value);

    let purged = 0;
    for (const row of due) {
      if (!row.storageKey) continue;
      try {
        await this.storage.delete(row.storageKey);
      } catch (error) {
        // Clearing the key anyway would orphan the object forever. Leave the
        // row alone so the next sweep retries it.
        this.logger.warn(
          `Could not delete expired export bundle ${row.storageKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          DataExportService.name,
        );
        continue;
      }

      await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(dataExports)
            .set({ storageKey: null })
            .where(eq(dataExports.id, row.id)),
        row.tenantId,
      );
      purged += 1;
    }

    return { purged };
  }

  private async findRow(tenantId: string, exportId: string) {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(dataExports)
          .where(
            and(
              eq(dataExports.id, exportId),
              eq(dataExports.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ?? null;
  }

  private async setStatus(
    tenantId: string,
    exportId: string,
    patch: Partial<typeof dataExports.$inferInsert>,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(dataExports)
          .set(patch)
          .where(
            and(
              eq(dataExports.id, exportId),
              eq(dataExports.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }
}

function toRecord(row: typeof dataExports.$inferSelect): DataExportRecord {
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requestedBy,
    rowCounts: row.rowCounts ?? null,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    error: row.error,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
