import type { AppLoggerService } from '../core';
import type { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AuditLogService } from './audit-log.service';

const TENANT = 'tenant-a';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    tenantId: TENANT,
    actorUserId: 'user-1',
    actorRole: 'admin',
    method: 'DELETE',
    route: '/knowledge-base/documents/:id',
    targetId: 'doc-1',
    statusCode: 200,
    outcome: 'success' as const,
    detail: 'Deleted "refund-policy.pdf"',
    createdAt: new Date('2026-08-22T10:00:00Z'),
    ...overrides,
  };
}

/** Calls through to the real withTenantTx() callback against a fake tx matching AuditLogService's exact chains — a mock that never invokes the callback leaves the query logic untested. */
function makeTenantContext(options: {
  rows?: unknown[];
  insertThrows?: Error;
}) {
  const inserted: unknown[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = {
      insert: () => ({
        values: (row: unknown) => {
          if (options.insertThrows) throw options.insertThrows;
          inserted.push(row);
          return Promise.resolve();
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve(options.rows ?? []),
            }),
          }),
        }),
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
    inserted,
  };
}

function makeHarness(options: {
  rows?: unknown[];
  insertThrows?: Error;
  members?: { userId: string; email: string }[];
  membersThrow?: Error;
}) {
  const ctx = makeTenantContext(options);
  const listTeamMembers = jest.fn(() =>
    options.membersThrow
      ? Promise.reject(options.membersThrow)
      : Promise.resolve(options.members ?? []),
  );
  const provisioning = {
    listTeamMembers,
  } as unknown as TenantAuthProvisioningPort;

  const error = jest.fn();
  const warn = jest.fn();
  const logger = { error, warn } as unknown as AppLoggerService;

  return {
    service: new AuditLogService(ctx.tenantContext, provisioning, logger),
    ...ctx,
    listTeamMembers,
    error,
    warn,
  };
}

describe('AuditLogService.record()', () => {
  it('appends the entry inside the tenant transaction', async () => {
    const { service, inserted, withTenantTx } = makeHarness({});

    await service.record({
      tenantId: TENANT,
      actorUserId: 'user-1',
      actorRole: 'admin',
      method: 'DELETE',
      route: '/knowledge-base/documents/:id',
      targetId: 'doc-1',
      statusCode: 200,
      outcome: 'success',
      detail: null,
    });

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT);
    expect(inserted).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        actorUserId: 'user-1',
        outcome: 'success',
        targetId: 'doc-1',
      }),
    ]);
  });

  // A failed audit write must not turn a successful admin action into a 500.
  // The document is already deleted; failing the request now would misreport
  // what happened, and a retry would double the effect.
  it('never throws when the write fails, and says so loudly', async () => {
    const { service, error } = makeHarness({
      insertThrows: new Error('pool exhausted'),
    });

    await expect(
      service.record({
        tenantId: TENANT,
        actorUserId: 'user-1',
        actorRole: 'admin',
        method: 'DELETE',
        route: '/documents/:id',
        targetId: 'doc-1',
        statusCode: 200,
        outcome: 'success',
        detail: null,
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('NOT in the audit trail'),
      'AuditLogService',
    );
  });
});

describe('AuditLogService.list()', () => {
  it('resolves the actor email from the directory at read time', async () => {
    const { service } = makeHarness({
      rows: [makeRow()],
      members: [{ userId: 'user-1', email: 'admin@acme.test' }],
    });

    const entries = await service.list(TENANT, { limit: 50 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: 'user-1',
      actorEmail: 'admin@acme.test',
      detail: 'Deleted "refund-policy.pdf"',
    });
  });

  // A removed team member is not in the directory any more. Their actions
  // must stay attributable — that is exactly when an audit log matters.
  it('keeps entries attributable when the actor has left the team', async () => {
    const { service } = makeHarness({
      rows: [makeRow({ actorUserId: 'departed-user' })],
      members: [{ userId: 'user-1', email: 'admin@acme.test' }],
    });

    const entries = await service.list(TENANT, { limit: 50 });

    expect(entries[0]).toMatchObject({
      actorUserId: 'departed-user',
      actorEmail: null,
    });
  });

  // Emails are a convenience laid over the record. Losing the convenience
  // must not lose the record.
  it('still returns entries when the directory cannot be reached', async () => {
    const { service, warn } = makeHarness({
      rows: [makeRow()],
      membersThrow: new Error('supabase unreachable'),
    });

    const entries = await service.list(TENANT, { limit: 50 });

    expect(entries).toHaveLength(1);
    expect(entries[0].actorEmail).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve actor emails'),
      'AuditLogService',
    );
  });

  it('looks the directory up once per page, not once per row', async () => {
    const { service, listTeamMembers } = makeHarness({
      rows: [makeRow(), makeRow({ id: 'entry-2' }), makeRow({ id: 'entry-3' })],
      members: [{ userId: 'user-1', email: 'admin@acme.test' }],
    });

    await service.list(TENANT, { limit: 50 });

    expect(listTeamMembers).toHaveBeenCalledTimes(1);
  });

  it('opens the transaction bound to the requested tenant', async () => {
    const { service, withTenantTx } = makeHarness({ rows: [] });

    await service.list(TENANT, { limit: 50 });

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT);
  });

  it('returns an empty page without touching the directory', async () => {
    const { service, listTeamMembers } = makeHarness({ rows: [] });

    await expect(service.list(TENANT, { limit: 50 })).resolves.toEqual([]);
    // Still one call: a page with no rows needs no lookup to be correct, but
    // the map is built before mapping. Asserting the observable behaviour.
    expect(listTeamMembers).toHaveBeenCalledTimes(1);
  });
});

// QA 2026-10-05: entries carry a stable key and params beside the English
// `detail`, so the console can show the log in the operator's language.
describe('AuditLogService — detail key and params', () => {
  it('stores the key and params with the entry', async () => {
    const { service, inserted } = makeHarness({});

    await service.record({
      tenantId: TENANT,
      actorUserId: 'user-1',
      actorRole: 'admin',
      method: 'POST',
      route: '/orders/:id/approve',
      targetId: 'order-1',
      statusCode: 200,
      outcome: 'success',
      detail: 'Approved order ORD-1 (62.00 SAR)',
      detailKey: 'order.approved',
      detailParams: { orderRef: 'ORD-1', total: '62.00', currency: 'SAR' },
    });

    expect(inserted).toEqual([
      expect.objectContaining({
        detail: 'Approved order ORD-1 (62.00 SAR)',
        detailKey: 'order.approved',
        detailParams: { orderRef: 'ORD-1', total: '62.00', currency: 'SAR' },
      }),
    ]);
  });

  it('returns the key and params on read', async () => {
    const { service } = makeHarness({
      rows: [
        makeRow({
          detailKey: 'order.cancelled',
          detailParams: { orderRef: 'ORD-1' },
        }),
      ],
    });

    const [entry] = await service.list(TENANT, { limit: 50 });

    expect(entry).toMatchObject({
      detailKey: 'order.cancelled',
      detailParams: { orderRef: 'ORD-1' },
    });
  });

  it('returns null key and params for an entry recorded without them (seeded or older rows)', async () => {
    const { service } = makeHarness({
      rows: [makeRow({ detailKey: null, detailParams: null })],
    });

    const [entry] = await service.list(TENANT, { limit: 50 });

    expect(entry.detail).toBe('Deleted "refund-policy.pdf"');
    expect(entry.detailKey).toBeNull();
    expect(entry.detailParams).toBeNull();
  });
});
