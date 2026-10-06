// Feature 24 (Store Integrations): sync tracking for product/inventory syncs.
// Records each sync run's stats (products synced/updated/failed) for debugging
// and monitoring. `StoreSyncJobService` is the only writer; see its header for
// how `products_updated` gets its real insert-vs-update split.
//
// RLS: same FORCE + NULLIF guard pattern as every other tenant table.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { storeConnections } from './store-connections.table';

export const SYNC_JOB_TYPES = ['product_sync', 'inventory_sync'] as const;
export type SyncJobType = (typeof SYNC_JOB_TYPES)[number];

export const SYNC_JOB_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

export const storeSyncJobs = pgTable(
  'store_sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storeConnectionId: uuid('store_connection_id')
      .notNull()
      .references(() => storeConnections.id, { onDelete: 'cascade' }),
    jobType: text('job_type').notNull(),
    status: text('status').notNull().default('pending'),
    productsSynced: integer('products_synced').default(0),
    productsUpdated: integer('products_updated').default(0),
    productsFailed: integer('products_failed').default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('store_sync_jobs_tenant_id_idx').on(table.tenantId),
    // FK with no index = Seq Scan on every `store_connections` delete cascade.
    index('store_sync_jobs_store_connection_id_idx').on(
      table.storeConnectionId,
    ),
    // The read the console actually performs: the latest job for one
    // connection (StoreSyncJobService.findLatestForConnection). Added by
    // migration 0058, when the first writer of this table landed.
    index('store_sync_jobs_connection_recent_idx').on(
      table.tenantId,
      table.storeConnectionId,
      table.createdAt.desc(),
    ),
  ],
).enableRLS();
