// TenantDirectoryService: the one question a platform-wide sweep may ask
// before it has a tenant. Every sweep's correctness under FORCE RLS starts
// here, so the two properties that matter are pinned: the scan pages through
// every tenant (a platform past 1000 workspaces must not silently stop
// sweeping the rest), and closed workspaces are left out unless the caller is
// housekeeping that must still reach them.
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PersistenceService } from '../persistence/persistence.service';
import { TenantDirectoryService } from './tenant-directory';

const PAGE = 1000;

function ids(from: number, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `00000000-0000-0000-0000-${String(from + i).padStart(12, '0')}`,
  );
}

/**
 * A fake admin query that serves `pages` in order and records each call's
 * WHERE clause, rendered to SQL + params so the assertions read the predicate
 * drizzle would actually send.
 */
function makeHarness(pages: string[][]) {
  const dialect = new PgDialect();
  const wheres: Array<{ sql: string; params: unknown[] } | undefined> = [];
  let call = 0;
  const runAdminQuery = jest.fn((fn: (db: unknown) => unknown) => {
    const page = pages[call++] ?? [];
    const self = {
      from: () => self,
      where: (condition: SQL | undefined) => {
        wheres.push(condition ? dialect.sqlToQuery(condition) : undefined);
        return self;
      },
      orderBy: () => self,
      limit: () => Promise.resolve(page.map((id) => ({ id }))),
    };
    return fn({ select: () => self });
  });
  const service = new TenantDirectoryService({
    runAdminQuery,
  } as unknown as PersistenceService);
  return { service, runAdminQuery, wheres };
}

describe('TenantDirectoryService.listTenantIds', () => {
  it('returns every id from a single short page with one query', async () => {
    const page = ids(1, 3);
    const { service, runAdminQuery } = makeHarness([page]);

    await expect(service.listTenantIds()).resolves.toEqual(page);
    expect(runAdminQuery).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when there are no tenants', async () => {
    const { service, runAdminQuery } = makeHarness([[]]);

    await expect(service.listTenantIds()).resolves.toEqual([]);
    expect(runAdminQuery).toHaveBeenCalledTimes(1);
  });

  it('pages past 1000 rows, continuing after the last id of the previous page', async () => {
    const first = ids(1, PAGE);
    const second = ids(PAGE + 1, 5);
    const { service, runAdminQuery, wheres } = makeHarness([first, second]);

    const result = await service.listTenantIds();

    expect(result).toHaveLength(PAGE + 5);
    expect(result).toEqual([...first, ...second]);
    expect(runAdminQuery).toHaveBeenCalledTimes(2);
    // The first page has no cursor; the second continues after the first
    // page's last id.
    expect(wheres[0]?.params).not.toContain(first[PAGE - 1]);
    expect(wheres[1]?.sql).toMatch(/"id" > \$\d/);
    expect(wheres[1]?.params).toContain(first[PAGE - 1]);
  });

  it('asks for one more page when the last page is exactly full', async () => {
    const first = ids(1, PAGE);
    const { service, runAdminQuery } = makeHarness([first, []]);

    await expect(service.listTenantIds()).resolves.toEqual(first);
    expect(runAdminQuery).toHaveBeenCalledTimes(2);
  });

  it('excludes closed workspaces by default', async () => {
    const { service, wheres } = makeHarness([ids(1, 2)]);

    await service.listTenantIds();

    expect(wheres[0]?.sql).toMatch(/"closed_at" is null/);
  });

  it('includes closed workspaces when asked (housekeeping)', async () => {
    const { service, wheres } = makeHarness([ids(1, 2)]);

    await service.listTenantIds({ includeClosed: true });

    // No predicate at all on the first page: every tenant, open or closed.
    expect(wheres[0]).toBeUndefined();
  });

  it('keeps the closed_at predicate on every page, not just the first', async () => {
    const first = ids(1, PAGE);
    const { service, wheres } = makeHarness([first, ids(PAGE + 1, 1)]);

    await service.listTenantIds();

    expect(wheres).toHaveLength(2);
    expect(wheres[1]?.sql).toMatch(/"closed_at" is null/);
    expect(wheres[1]?.sql).toMatch(/"id" > \$\d/);
  });
});
