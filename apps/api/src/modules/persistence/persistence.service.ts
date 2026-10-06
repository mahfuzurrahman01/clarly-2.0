// Platform (PersistenceModule): migration runner + connection lifecycle.
// Exposed to the rest of the app only through this service and the
// TenantContextModule — never the raw Pool/DrizzleDb instances, which are
// injected here via the PG_POOL/DRIZZLE_DB tokens defined in
// persistence.providers.ts and kept private.
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { join } from 'node:path';
import { AppLoggerService } from '../core/logger/app-logger.service';
import { DRIZZLE_DB, PG_POOL, type DrizzleDb } from './persistence.providers';

const MIGRATIONS_FOLDER = join(__dirname, 'drizzle', 'migrations');

@Injectable()
export class PersistenceService implements OnModuleDestroy {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Applies pending drizzle-kit-generated migrations. Called explicitly from
   * a CI `migrate` step and from test bootstrap — never automatically on app
   * startup, so a bad migration can't be applied by an API replica racing
   * another replica's boot.
   */
  async runMigrations(): Promise<void> {
    this.logger.log(
      `Running migrations from ${MIGRATIONS_FOLDER}`,
      'PersistenceService',
    );
    await migrate(this.db, { migrationsFolder: MIGRATIONS_FOLDER });
    this.logger.log('Migrations complete', 'PersistenceService');
  }

  /** Basic connectivity check — used by the throwaway Feature 0 exit-criteria test. */
  async ping(): Promise<boolean> {
    const result = await this.pool.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  /**
   * Escape hatch for the small set of legitimately non-tenant-scoped
   * queries — platform bootstrapping only (e.g. inserting a `tenants` row
   * itself, which can't have a tenant context because the tenant doesn't
   * exist yet until this insert). Every tenant-scoped table must go
   * through TenantContextService.withTenantTx() instead, never this — RLS
   * only protects rows queried under a set `app.tenant_id` GUC.
   */
  async runAdminQuery<T>(fn: (db: DrizzleDb) => Promise<T>): Promise<T> {
    return fn(this.db);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
