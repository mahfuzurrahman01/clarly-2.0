// A tenant's request for a copy of everything the platform holds about them.
//
// GDPR Article 15 (right of access) and a routine procurement ask. Async by
// necessity rather than by taste: a busy workspace has hundreds of thousands
// of messages, and assembling that inside a request/response cycle would time
// out on exactly the tenants most likely to ask.
//
//   POST /data-exports  ─►  pending ──► running ──► ready  ──► download
//                                          │                     │
//                                          └──► failed           └─► expiresAt
//
// The finished bundle is a stored object like any other. It holds a complete
// copy of the workspace, so it is the single most sensitive artifact this
// system produces: `expiresAt` exists so one does not sit in a bucket forever
// waiting to be found.
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const DATA_EXPORT_STATUSES = [
  'pending',
  'running',
  'ready',
  'failed',
] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

/** How many rows each table contributed. Lets a tenant check the export is complete without parsing the bundle. */
export type DataExportCounts = Record<string, number>;

export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Supabase Auth user id of the admin who asked. No FK — there is no local users table. */
    requestedBy: text('requested_by').notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<DataExportStatus>(),
    /** Null until the bundle exists. Points at object storage, same as a KB document. */
    storageKey: text('storage_key'),
    sizeBytes: text('size_bytes'),
    rowCounts: jsonb('row_counts').$type<DataExportCounts>(),
    /** Why it failed, shown to the tenant — an export that silently never finishes is worse than one that says why. */
    error: text('error'),
    /**
     * When the stored bundle is deleted. A full copy of a workspace must not
     * linger indefinitely: the export is the highest-value single object in
     * the system for anyone who should not have it.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('data_exports_tenant_created_idx').on(
      table.tenantId,
      table.createdAt.desc(),
    ),
    // The expiry sweep's only question, and partial for the same reason the
    // tenant purge index is: most rows never have an expiry pending.
    index('data_exports_expiry_idx')
      .on(table.expiresAt)
      .where(
        sql`${table.expiresAt} IS NOT NULL AND ${table.storageKey} IS NOT NULL`,
      ),
  ],
).enableRLS();
