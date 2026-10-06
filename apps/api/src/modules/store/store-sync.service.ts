// Feature 24 (Store Integrations): product sync service.
// Syncs products from connected stores into F20's `products` table.
//
// Every write is tenant-scoped through CatalogService (which itself goes
// through withTenantTx), and the connection is always passed in whole rather
// than re-fetched by id without a tenant — the connection row is what carries
// the tenant this sync belongs to.
//
// Each run also records a `store_sync_jobs` row (queued -> running ->
// completed/failed, with the synced/error counts and the failure message).
// The table and its indexes shipped with migration 0052 and nothing ever
// wrote to it, so a store that had failed every sync for a week was
// indistinguishable from one that had never synced. Job recording is
// best-effort inside StoreSyncJobService and can never fail a sync.
import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { AppConfigService } from '../core/config/app-config.service';
import { AppLoggerService } from '../core';
import {
  StoreConnectionService,
  type StoreConnection,
} from './store-connection.service';
import { StoreOAuthService } from './store-oauth.service';
import { StoreProviderRegistry } from './store-provider.registry';
import { StoreSyncJobService } from './store-sync-job.service';

export interface SyncResult {
  synced: number;
  errors: number;
}

/**
 * How many product pages one sync run will walk before stopping.
 *
 * The loop's exit condition comes from the store, and with WooCommerce the
 * store is a WordPress host the merchant controls end to end — the adapter
 * reads its `X-WP-TotalPages` header verbatim. A host that always reports
 * another page (whether hostile or merely broken) would otherwise pin the
 * sweep on one connection forever, starving every other tenant's sync,
 * since the sweep is a single in-process loop.
 *
 * 200 pages is ~20k products at the providers' 100-per-page maximum, well
 * past any catalogue we target; hitting it means something is wrong, not
 * that a merchant is large.
 */
export const MAX_PRODUCT_SYNC_PAGES = 200;

@Injectable()
export class StoreSyncService {
  constructor(
    private readonly connectionService: StoreConnectionService,
    private readonly oauthService: StoreOAuthService,
    private readonly catalogService: CatalogService,
    private readonly registry: StoreProviderRegistry,
    private readonly syncJobService: StoreSyncJobService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  async syncConnection(connection: StoreConnection): Promise<SyncResult> {
    if (!connection.isActive) {
      this.logger.warn(
        `Skipping sync for inactive connection ${connection.id}`,
        'StoreSyncService',
      );
      return { synced: 0, errors: 0 };
    }

    const adapter = this.registry.forProvider(connection.provider);
    const jobId = await this.syncJobService.enqueue(
      connection.tenantId,
      connection.id,
      'product_sync',
    );
    let synced = 0;
    let updated = 0;
    let errors = 0;
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;

    if (jobId) {
      await this.syncJobService.markRunning(connection.tenantId, jobId);
    }

    try {
      const { accessToken, authorizationToken } =
        await this.oauthService.ensureCredentials(connection);
      do {
        const result = await adapter.listProducts(accessToken, cursor, {
          shop: connection.storeId,
          authorizationToken,
        });
        for (const product of result.products) {
          try {
            const { created } = await this.catalogService.upsertProductDetailed(
              connection.tenantId,
              {
                name: product.name,
                nameAr: product.nameAr,
                sku: product.sku ?? product.externalId,
                price: product.price,
                currency: product.currency,
                stock: product.stock,
                stockStatus: product.stockStatus,
                imageUrl: product.imageUrl,
                category: product.category,
                // `source` + `storeExternalId` are the local↔store link
                // CreateOrderExecutor validates against; keep both, plus
                // whatever provider-specific ids the adapter surfaced.
                metadata: {
                  ...product.metadata,
                  source: connection.provider,
                  storeExternalId: product.externalId,
                  storeConnectionId: connection.id,
                },
              },
            );
            synced++;
            if (!created) updated++;
          } catch (err) {
            this.logger.error(
              `Failed to sync product ${product.externalId}: ${err}`,
              'StoreSyncService',
            );
            errors++;
          }
        }
        cursor = result.hasNextPage ? result.nextCursor : undefined;
        pages++;
        if (cursor && pages >= MAX_PRODUCT_SYNC_PAGES) {
          truncated = true;
          cursor = undefined;
        }
      } while (cursor);

      if (truncated) {
        this.logger.warn(
          `Product sync for connection ${connection.id} stopped at the ${MAX_PRODUCT_SYNC_PAGES}-page cap; the store kept reporting more pages`,
          'StoreSyncService',
        );
      }

      await this.connectionService.markSynced(
        connection.tenantId,
        connection.id,
      );
      this.logger.log(
        `Product sync completed for connection ${connection.id}: ${synced} synced, ${errors} errors`,
        'StoreSyncService',
      );
      if (jobId) {
        await this.syncJobService.markCompleted(connection.tenantId, jobId, {
          synced,
          updated,
          errors,
          // Not a clean success: the catalogue is a prefix of the store's,
          // so the row has to say so or the console reports a full sync.
          ...(truncated
            ? {
                warning: `Stopped at the ${MAX_PRODUCT_SYNC_PAGES}-page cap; not all products were synced`,
              }
            : {}),
        });
      }
    } catch (err) {
      this.logger.error(
        `Product sync failed for connection ${connection.id}: ${err}`,
        'StoreSyncService',
      );
      errors++;
      if (jobId) {
        await this.syncJobService.markFailed(
          connection.tenantId,
          jobId,
          err instanceof Error ? err.message : String(err),
          { synced, errors },
        );
      }
    }

    return { synced, errors };
  }

  async syncAllForTenant(tenantId: string): Promise<SyncResult> {
    const connections =
      await this.connectionService.findActiveByTenant(tenantId);
    const totals: SyncResult = { synced: 0, errors: 0 };
    for (const connection of connections) {
      const result = await this.syncConnection(connection);
      totals.synced += result.synced;
      totals.errors += result.errors;
    }
    return totals;
  }

  getIntervalMs(): number {
    return this.config.storeSyncIntervalMs;
  }
}
