// Which tenants exist — the one question a platform-wide background job may
// ask before it has a tenant.
//
// Every tenant table is FORCE ROW LEVEL SECURITY, and the production role is
// NOBYPASSRLS, so a sweep that reads a tenant table through `runAdminQuery`
// (no `app.tenant_id`) gets ZERO rows back — silently. That is how the
// courier poll, store sync, order expiry and export purge sweeps all found
// nothing to do (fixed in Clarly 2.0). The rule for every sweep is therefore:
//
//   1. list tenant ids here (`tenants` is not RLS-scoped);
//   2. run the per-tenant work with `sweepTenantsWithBoundedConcurrency`,
//      inside `withTenantTx(tenantId)`.
import { Injectable } from '@nestjs/common';
import { asc, gt, and, isNull, type SQL } from 'drizzle-orm';
import { tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';

/** Page size for the id scan; keeps one query small even with many tenants. */
const PAGE = 1000;

@Injectable()
export class TenantDirectoryService {
  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Every tenant id, ordered. Closed (offboarding) workspaces are excluded
   * unless `includeClosed` — housekeeping such as purging expired export
   * files must still reach them; customer-facing work must not.
   */
  async listTenantIds(
    options: { includeClosed?: boolean } = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const conditions: SQL[] = [];
      if (!options.includeClosed) conditions.push(isNull(tenants.closedAt));
      if (after) conditions.push(gt(tenants.id, after));
      const page = await this.persistence.runAdminQuery((db) =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(tenants.id))
          .limit(PAGE),
      );
      ids.push(...page.map((row) => row.id));
      if (page.length < PAGE) return ids;
      after = page[page.length - 1].id;
    }
  }
}
