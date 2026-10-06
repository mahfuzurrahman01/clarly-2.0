import * as schema from '../persistence/drizzle/schema';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { DataExportAssemblerService } from './data-export-assembler.service';

const TENANT = 'tenant-a';

/**
 * Tables that are genuinely NOT a tenant's data, each with the reason. The
 * guard test below treats this plus the exported list as the complete
 * accounting of the schema — anything else is unexplained.
 */
const DELIBERATELY_EXCLUDED: Record<string, string> = {
  tenants: 'the workspace row itself, emitted as bundle metadata',
  plans: 'platform catalog, identical for every tenant',
  stripe_customer_tenant_map: 'internal Stripe webhook routing, no content',
  webhook_message_dedup: 'transient idempotency keys',
  meta_data_deletion_requests:
    'platform-level record of Meta user deletion requests, no tenant_id',
  store_webhook_events:
    'F24 webhook idempotency log, keyed by (provider, store_id) before a tenant is resolved — no tenant_id',
  courier_webhook_events:
    'F26 courier push idempotency log, keyed by (courier, account_ref) before a tenant is resolved — no tenant_id (D7 carve-out)',
  platform_admins:
    'Clarly 2.0 S1: the platform operator directory — our staff, not tenant data, no tenant_id',
  courier_routes:
    'Clarly 2.0 (migration 0073): pre-tenant courier webhook routing key (courier, account_ref) -> tenant, derived from courier_connections, no content',
  store_routes:
    'Clarly 2.0 (migration 0073): pre-tenant store webhook routing key (provider, store_id) -> tenant, derived from store_connections, no content',
  // TODO(v2 S4): TEMPORARY. These five S4 tables exist (migration 0074) but
  // their services are not written yet. S4 MUST remove them from this list
  // and add broadcasts/broadcast_recipients/followups/followup_settings/
  // channel_pauses to DataExportAssemblerService — they are tenant data.
  channel_pauses: 'TEMPORARY (v2 S4 WIP) — must be exported once S4 lands',
  broadcasts: 'TEMPORARY (v2 S4 WIP) — must be exported once S4 lands',
  broadcast_recipients:
    'TEMPORARY (v2 S4 WIP) — must be exported once S4 lands',
  followup_settings: 'TEMPORARY (v2 S4 WIP) — must be exported once S4 lands',
  followups: 'TEMPORARY (v2 S4 WIP) — must be exported once S4 lands',
};

/** Drizzle keeps the SQL name on a well-known symbol; read it rather than guessing from the variable name. */
function tableName(table: object): string | null {
  const symbol = Object.getOwnPropertySymbols(table).find((s) =>
    s.description?.includes('Name'),
  );
  const value = symbol
    ? (table as unknown as Record<symbol, unknown>)[symbol]
    : undefined;
  return typeof value === 'string' ? value : null;
}

/** Every SQL table name the drizzle schema barrel exports. */
function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (typeof value !== 'object' || value === null) continue;
    const name = tableName(value);
    if (name !== null) names.push(name);
  }
  return names;
}

function makeService(rowsPerTable: unknown[] = []) {
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({ where: () => Promise.resolve(rowsPerTable) }),
      }),
    }),
  );
  return {
    service: new DataExportAssemblerService({
      withTenantTx,
    } as unknown as TenantContextService),
    withTenantTx,
  };
}

describe('DataExportAssemblerService — completeness guard', () => {
  // The whole point of the feature. An export that quietly omits a table
  // answers a legal obligation with something that looks right and is not, and
  // nobody finds the gap until it matters. This test is what makes adding a
  // table to the schema a decision about the export rather than an oversight.
  it('accounts for every table in the schema, as exported or explicitly excluded', () => {
    const exported = new Set(DataExportAssemblerService.exportedTableNames());

    const schemaTables = schemaTableNames();

    expect(schemaTables.length).toBeGreaterThan(20);

    const unaccounted = schemaTables.filter(
      (name) => !exported.has(name) && !(name in DELIBERATELY_EXCLUDED),
    );

    expect(unaccounted).toEqual([]);
  });

  it('does not claim to export a table that no longer exists', () => {
    const schemaTables = new Set(schemaTableNames());

    const stale = DataExportAssemblerService.exportedTableNames().filter(
      (name) => !schemaTables.has(name),
    );

    expect(stale).toEqual([]);
  });
});

describe('DataExportAssemblerService.assemble()', () => {
  it('reads every exported table inside the tenant transaction', async () => {
    const { service, withTenantTx } = makeService();

    await service.assemble(TENANT);

    expect(withTenantTx).toHaveBeenCalledTimes(
      DataExportAssemblerService.exportedTableNames().length,
    );
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT);
  });

  it('produces a versioned bundle naming its own tables', async () => {
    const { service } = makeService([{ id: 'row-1' }]);

    const { content } = await service.assemble(TENANT);
    const bundle = JSON.parse(content.toString('utf8')) as {
      formatVersion: number;
      tenantId: string;
      tables: string[];
      data: Record<string, unknown[]>;
    };

    expect(bundle.formatVersion).toBe(1);
    expect(bundle.tenantId).toBe(TENANT);
    // Listing the table names lets a reader tell "empty" from "not included"
    // without a copy of our schema.
    expect(bundle.tables).toEqual(
      DataExportAssemblerService.exportedTableNames(),
    );
    expect(bundle.data.messages).toEqual([{ id: 'row-1' }]);
  });

  it('reports a row count per table so completeness is checkable without parsing', async () => {
    const { service } = makeService([{ id: 'a' }, { id: 'b' }]);

    const { rowCounts } = await service.assemble(TENANT);

    expect(rowCounts.messages).toBe(2);
    expect(Object.keys(rowCounts)).toEqual(
      DataExportAssemblerService.exportedTableNames(),
    );
  });

  it('emits an empty array rather than omitting a table with no rows', async () => {
    const { service } = makeService([]);

    const { content } = await service.assemble(TENANT);
    const bundle = JSON.parse(content.toString('utf8')) as {
      data: Record<string, unknown[]>;
    };

    for (const name of DataExportAssemblerService.exportedTableNames()) {
      expect(bundle.data[name]).toEqual([]);
    }
  });
});
