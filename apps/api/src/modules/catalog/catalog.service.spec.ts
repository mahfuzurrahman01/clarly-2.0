// F20 retroactive review (2026-09-21): the previous version of this spec
// asserted its own mock's canned row back ("expect(result.stock).toBe(10)"
// on a mock that returned 10), so every real defect in this service —
// dropped category filter, unescaped LIKE wildcards, the two-transaction
// upsert race — passed it.
//
// These tests assert the SQL the service actually builds. The fake tx
// records the drizzle fragments handed to values()/where()/set()/
// onConflictDoUpdate() and renders them through PgDialect, so a change that
// stops filtering by category, stops using the full-text index, or goes back
// to select-then-insert fails here without needing a database.
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CatalogService } from './catalog.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';

const dialect = new PgDialect();

function render(fragment: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment as SQL);
  return { sql: query.sql, params: query.params };
}

interface SelectCall {
  where: unknown;
  orderBy?: unknown;
  limit?: number;
  offset?: number;
}

interface InsertCall {
  values: Record<string, unknown>[];
  onConflict?: { target: unknown; set: Record<string, unknown> };
  returning?: unknown;
}

interface UpdateCall {
  set: Record<string, unknown>;
  where: unknown;
}

interface Harness {
  tenantContext: TenantContextService;
  /** Raw statements run through `tx.execute()` — the trigram threshold is one. */
  executed: unknown[];
  /** The same jest.fn() behind `tenantContext.withTenantTx`, assertable without unbound-method noise. */
  withTenantTx: jest.Mock;
  selects: SelectCall[];
  inserts: InsertCall[];
  updates: UpdateCall[];
  tenantIds: unknown[];
}

/**
 * @param selectResults rows returned by each successive select, in order.
 */
function makeHarness(options: {
  selectResults?: unknown[][];
  insertResult?: unknown[];
  updateResult?: unknown[];
}): Harness {
  const selects: SelectCall[] = [];
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  const tenantIds: unknown[] = [];
  const executed: unknown[] = [];
  const selectResults = [...(options.selectResults ?? [])];

  const makeTx = () => ({
    execute: (statement: unknown) => {
      executed.push(statement);
      return Promise.resolve({ rows: [] });
    },
    select: () => ({
      from: () => {
        const call: SelectCall = { where: undefined };
        const rows = () => Promise.resolve(selectResults.shift() ?? []);
        const chain = {
          where: (where: unknown) => {
            call.where = where;
            selects.push(call);
            return chain;
          },
          orderBy: (orderBy: unknown) => {
            call.orderBy = orderBy;
            return chain;
          },
          limit: (limit: number) => {
            call.limit = limit;
            return Object.assign(rows(), chain, {
              offset: (offset: number) => {
                call.offset = offset;
                return rows();
              },
            });
          },
          then: (...args: unknown[]) =>
            (rows() as unknown as Promise<unknown>).then(
              ...(args as [never, never]),
            ),
        };
        return chain;
      },
    }),
    insert: () => {
      const call: InsertCall = { values: [] };
      const chain = {
        values: (
          values: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          call.values = Array.isArray(values) ? values : [values];
          inserts.push(call);
          return chain;
        },
        onConflictDoUpdate: (config: {
          target: unknown;
          set: Record<string, unknown>;
        }) => {
          call.onConflict = config;
          return chain;
        },
        returning: (selection?: unknown) => {
          call.returning = selection;
          return Promise.resolve(options.insertResult ?? []);
        },
      };
      return chain;
    },
    update: () => {
      const call: UpdateCall = { set: {}, where: undefined };
      const chain = {
        set: (values: Record<string, unknown>) => {
          call.set = values;
          return chain;
        },
        where: (where: unknown) => {
          call.where = where;
          updates.push(call);
          return chain;
        },
        returning: () => Promise.resolve(options.updateResult ?? []),
      };
      return chain;
    },
  });

  const withTenantTx = jest.fn(
    (fn: (tx: unknown) => unknown, tenantId: unknown) => {
      tenantIds.push(tenantId);
      return fn(makeTx());
    },
  );
  const tenantContext = { withTenantTx } as unknown as TenantContextService;

  return {
    tenantContext,
    withTenantTx,
    selects,
    inserts,
    updates,
    tenantIds,
    executed,
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    tenantId: TENANT,
    name: 'Wireless Mouse',
    nameAr: 'ماوس لاسلكي',
    sku: 'WM-001',
    description: null,
    descriptionAr: null,
    price: '49.99',
    currency: 'SAR',
    stock: 7,
    stockStatus: 'in_stock',
    imageUrl: null,
    imageObjectKey: null,
    category: 'Electronics',
    tags: [],
    metadata: {},
    isActive: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

describe('CatalogService', () => {
  describe('createProduct', () => {
    it('applies the documented defaults rather than writing nulls into NOT NULL columns', async () => {
      const harness = makeHarness({ insertResult: [productRow()] });
      const service = new CatalogService(harness.tenantContext);

      await service.createProduct(TENANT, {
        name: 'Wireless Mouse',
        price: 49.9,
      });

      expect(harness.inserts).toHaveLength(1);
      expect(harness.inserts[0].values[0]).toMatchObject({
        tenantId: TENANT,
        name: 'Wireless Mouse',
        // numeric(12,2) is a string column — a JS number here would round-trip
        // through the driver as a float.
        price: '49.9',
        currency: 'SAR',
        stock: 0,
        stockStatus: 'in_stock',
        tags: [],
        metadata: {},
      });
      expect(harness.tenantIds).toEqual([TENANT]);
    });
  });

  describe('upsertProductsDetailed', () => {
    it('is ONE atomic insert ... on conflict (tenant_id, sku) do update, not select-then-write', async () => {
      const harness = makeHarness({
        insertResult: [{ ...productRow(), wasInserted: true }],
      });
      const service = new CatalogService(harness.tenantContext);

      await service.upsertProduct(TENANT, {
        name: 'Wireless Mouse',
        sku: 'WM-001',
        price: 49.99,
      });

      // The race this replaced: a select in one transaction and an insert in
      // another meant two concurrent importers both saw "no row" and the
      // loser died on products_tenant_id_sku_unique.
      expect(harness.selects).toHaveLength(0);
      expect(harness.inserts).toHaveLength(1);
      expect(harness.withTenantTx.mock.calls).toHaveLength(1);

      const conflict = harness.inserts[0].onConflict!;
      expect(render(sql`${conflict.target as SQL}`).sql).toMatch(
        /tenant_id.*sku|sku.*tenant_id/s,
      );
      expect(render(conflict.set.price).sql).toBe('excluded.price');
      expect(render(conflict.set.stock).sql).toBe('excluded.stock');
      // A soft-deleted product that reappears in the merchant's CSV comes back.
      expect(render(conflict.set.isActive).sql).toBe('true');
    });

    it('reports created vs updated from xmax rather than a second read', async () => {
      const harness = makeHarness({
        insertResult: [
          { ...productRow(), wasInserted: true },
          { ...productRow({ id: 'b', sku: 'WM-002' }), wasInserted: false },
        ],
      });
      const service = new CatalogService(harness.tenantContext);

      const results = await service.upsertProductsDetailed(TENANT, [
        { name: 'A', sku: 'WM-001', price: 1 },
        { name: 'B', sku: 'WM-002', price: 2 },
      ]);

      expect(results.map((r) => r.created)).toEqual([true, false]);
      // `wasInserted` is an implementation detail of the returning clause and
      // must not leak into the product record.
      expect(results[0].product).not.toHaveProperty('wasInserted');
      expect(
        render(
          (harness.inserts[0].returning as Record<string, unknown>).wasInserted,
        ).sql,
      ).toBe('(xmax = 0)');
      // One statement for the whole batch — not one round trip per row.
      expect(harness.inserts).toHaveLength(1);
      expect(harness.inserts[0].values).toHaveLength(2);
    });

    it('does nothing at all for an empty batch', async () => {
      const harness = makeHarness({});
      const service = new CatalogService(harness.tenantContext);

      await expect(service.upsertProductsDetailed(TENANT, [])).resolves.toEqual(
        [],
      );
      expect(harness.withTenantTx).not.toHaveBeenCalled();
    });
  });

  describe('searchProducts', () => {
    it('uses the full-text index expression, not a substring scan', async () => {
      const harness = makeHarness({
        selectResults: [[productRow(), productRow({ id: 'b' })]],
      });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'wireless mouse', { limit: 2 });

      expect(harness.selects).toHaveLength(1);
      const rendered = render(harness.selects[0].where);
      expect(rendered.sql).toContain('to_tsvector');
      expect(rendered.sql).toContain('plainto_tsquery');
      // Tolerant search: one bound tsquery per token, OR-ed, never the phrase.
      expect(rendered.params).toEqual(
        expect.arrayContaining(['wireless', 'mouse']),
      );
      expect(rendered.sql).toContain(' || ');
      expect(rendered.params).toContain(TENANT);
      expect(render(harness.selects[0].orderBy).sql).toContain('ts_rank');
      expect(harness.selects[0].limit).toBe(2);
    });

    it('applies the advertised category filter (the tool arg the executor used to drop)', async () => {
      const harness = makeHarness({ selectResults: [[productRow()]] });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mouse', {
        limit: 1,
        category: 'Electronics',
      });

      // "Electronics" is a recognised category word, so it is matched
      // case-insensitively against every spelling a tenant may have stored.
      const rendered = render(harness.selects[0].where);
      expect(rendered.sql).toContain('lower("products"."category") in (');
      expect(rendered.params).toContain('electronics');
    });

    it('matches a recognised category word against every stored spelling, case-insensitively', async () => {
      const harness = makeHarness({ selectResults: [[productRow()]] });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'أدوات المطبخ', {
        limit: 10,
        category: 'kitchen',
      });

      const rendered = render(harness.selects[0].where);
      expect(rendered.sql).toContain('lower("products"."category") in (');
      expect(rendered.params).toEqual(
        expect.arrayContaining(['kitchen', 'مطبخ']),
      );
    });

    it('never runs a query at all for an empty or whitespace term', async () => {
      const harness = makeHarness({});
      const service = new CatalogService(harness.tenantContext);

      await expect(service.searchProducts(TENANT, '   ')).resolves.toEqual([]);
      expect(harness.withTenantTx).not.toHaveBeenCalled();
    });

    it('escapes LIKE wildcards so a "%" query cannot dump the whole catalog', async () => {
      const harness = makeHarness({ selectResults: [[], []] });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, '%', { limit: 5 });

      // Second select is the substring fallback.
      const fallback = render(harness.selects[1].where);
      expect(fallback.params).toContain('%\\%%');
      expect(fallback.params).not.toContain('%%%');
    });

    it('falls back to a bounded substring pass only when full text under-delivers, excluding rows already found', async () => {
      const harness = makeHarness({
        selectResults: [[productRow()], [productRow({ id: 'fallback' })]],
      });
      const service = new CatalogService(harness.tenantContext);

      const rows = await service.searchProducts(TENANT, 'WM-0', { limit: 3 });

      // Three passes: full text under-delivered, so substring ran, and the
      // two of them together still left a slot for the trigram pass.
      expect(harness.selects).toHaveLength(3);
      // Only the remaining slots, so a fallback can never exceed the limit.
      expect(harness.selects[1].limit).toBe(2);
      expect(render(harness.selects[1].where).params).toContain(
        productRow().id,
      );
      expect(rows).toHaveLength(2);
    });

    it('adds a trigram pass when full text and substring both under-deliver, so a misspelling still resolves', async () => {
      const harness = makeHarness({
        selectResults: [
          [productRow({ id: 'fts' })],
          [],
          [productRow({ id: 'fuzzy' })],
        ],
      });
      const service = new CatalogService(harness.tenantContext);

      const rows = await service.searchProducts(TENANT, 'wirless mous', {
        limit: 3,
      });

      expect(harness.selects).toHaveLength(3);
      const fuzzy = render(harness.selects[2].where);
      // `%` — the operator the GIN trigram index (0057) serves. A
      // `similarity(...) > 0.3` here would be a sequential scan per turn.
      expect(fuzzy.sql).toContain('%');
      expect(fuzzy.params).toContain('wirless mous');
      expect(render(harness.selects[2].orderBy).sql).toContain('similarity');
      // Fuzzy is the last-resort pass: exact/full-text hits come first.
      expect(rows.map((row) => row.id)).toEqual(['fts', 'fuzzy']);
    });

    it('pins the trigram threshold transaction-locally before the fuzzy pass runs', async () => {
      const harness = makeHarness({ selectResults: [[], [], []] });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mous', { limit: 5 });

      expect(harness.executed).toHaveLength(1);
      const threshold = render(harness.executed[0]);
      expect(threshold.sql).toContain('pg_trgm.similarity_threshold');
      expect(threshold.params).toContain('0.3');
    });

    it('bounds the fuzzy pass to the remaining slots and excludes rows already returned', async () => {
      const harness = makeHarness({
        selectResults: [
          [productRow({ id: 'fts' })],
          [productRow({ id: 'substr' })],
          [],
        ],
      });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mous', { limit: 3 });

      expect(harness.selects[2].limit).toBe(1);
      const where = render(harness.selects[2].where);
      expect(where.params).toContain('fts');
      expect(where.params).toContain('substr');
    });

    it('never runs a fuzzy pass once the limit is filled — an agent turn pays for at most what it needs', async () => {
      const harness = makeHarness({
        selectResults: [[productRow()], [productRow({ id: 'substr' })]],
      });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mous', { limit: 2 });

      expect(harness.selects).toHaveLength(2);
      expect(harness.executed).toHaveLength(0);
    });

    it('skips the fallback entirely when full text already filled the limit', async () => {
      const harness = makeHarness({
        selectResults: [[productRow(), productRow({ id: 'b' })]],
      });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mouse', { limit: 2 });

      expect(harness.selects).toHaveLength(1);
    });

    it('scopes every pass to the caller tenant and active rows', async () => {
      const harness = makeHarness({ selectResults: [[], []] });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mouse', { limit: 5 });

      for (const call of harness.selects) {
        expect(render(call.where).params).toContain(TENANT);
        expect(render(call.where).params).not.toContain(OTHER_TENANT);
      }
      expect(harness.tenantIds).toEqual([TENANT]);
    });

    it('still accepts a bare numeric limit (the shape store sync and older callers use)', async () => {
      const harness = makeHarness({ selectResults: [[productRow()]] });
      const service = new CatalogService(harness.tenantContext);

      await service.searchProducts(TENANT, 'mouse', 1);

      expect(harness.selects[0].limit).toBe(1);
    });
  });

  describe('listProducts', () => {
    it('escapes wildcards in the console search filter too', async () => {
      const harness = makeHarness({ selectResults: [[{ count: 0 }], []] });
      const service = new CatalogService(harness.tenantContext);

      await service.listProducts(TENANT, { search: '100%_off' });

      const where = render(harness.selects[0].where);
      expect(where.params).toContain('%100\\%\\_off%');
    });

    it('caps the page size at 100 however large a limit is asked for', async () => {
      const harness = makeHarness({ selectResults: [[{ count: 0 }], []] });
      const service = new CatalogService(harness.tenantContext);

      await service.listProducts(TENANT, { limit: 100_000 });

      expect(harness.selects[1].limit).toBe(100);
    });
  });

  describe('updateStock', () => {
    // The F20 review's silent-no-op bug: store sync writes the store's id to
    // `sku` ONLY when the store gave no SKU of its own, but always to
    // metadata.storeExternalId — so matching on sku alone missed every
    // product with a real SKU and the webhook reported success anyway.
    it('matches on sku OR metadata.storeExternalId', async () => {
      const harness = makeHarness({ updateResult: [{ id: 'p1' }] });
      const service = new CatalogService(harness.tenantContext);

      await expect(
        service.updateStock(TENANT, 'store-product-123', 4),
      ).resolves.toBe(true);

      const where = render(harness.updates[0].where);
      expect(where.sql).toContain("->> 'storeExternalId'");
      expect(where.params).toContain('store-product-123');
      expect(harness.updates[0].set).toMatchObject({
        stock: 4,
        stockStatus: 'in_stock',
      });
    });

    it('flips stock_status to out_of_stock at zero and reports a miss honestly', async () => {
      const harness = makeHarness({ updateResult: [] });
      const service = new CatalogService(harness.tenantContext);

      await expect(service.updateStock(TENANT, 'nope', 0)).resolves.toBe(false);
      expect(harness.updates[0].set).toMatchObject({
        stock: 0,
        stockStatus: 'out_of_stock',
      });
    });
  });

  describe('updateProduct', () => {
    it('only sets the fields that were supplied, and always bumps updated_at', async () => {
      const harness = makeHarness({ updateResult: [productRow()] });
      const service = new CatalogService(harness.tenantContext);

      await service.updateProduct(TENANT, productRow().id, { stock: 3 });

      expect(Object.keys(harness.updates[0].set).sort()).toEqual([
        'stock',
        'updatedAt',
      ]);
    });

    it('returns null (not a throw, not a phantom row) when nothing matched', async () => {
      const harness = makeHarness({ updateResult: [] });
      const service = new CatalogService(harness.tenantContext);

      await expect(
        service.updateProduct(TENANT, productRow().id, { stock: 3 }),
      ).resolves.toBeNull();
    });
  });
});
