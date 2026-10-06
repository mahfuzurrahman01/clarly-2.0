// F26 (D10 Unit): credential encryption and tenant isolation for
// `courier_connections`.
//
// The fake transaction emulates the one property RLS gives us — inside
// `withTenantTx(fn, tenantId)` only that tenant's rows exist — so these tests
// fail loudly if anyone reverts to a raw DB handle outside a tenant
// transaction, which is precisely what F24 did.
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import type { AppConfigService, AppLoggerService } from '../core';
import { courierRoutes } from '../persistence/drizzle/schema';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CourierConnectionService } from './courier-connection.service';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';

jest.mock('../notifications/notification-resolution', () => ({
  markEntityNotificationsRead: jest.fn().mockResolvedValue(1),
}));

const ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');

interface FakeRow {
  id: string;
  tenantId: string;
  courier: string;
  credentials: string;
  accountRef: string;
  webhookSecret: string | null;
  isActive: boolean;
  lastVerifiedAt: Date | null;
  lastPolledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Drizzle builds `and(eq(id, …), eq(tenantId, …))` as an SQL object whose
 * `queryChunks` carry the bound params. Pulling the literal values back out is
 * what lets this fake honour the ID half of a predicate — without it an
 * `update ... where id = 'conn-b'` would silently rewrite every visible row,
 * and an isolation test would pass for the wrong reason.
 */
function boundValues(condition: unknown): string[] {
  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.value === 'string') values.push(record.value);
    const chunks = record.queryChunks;
    if (Array.isArray(chunks)) chunks.forEach(walk);
  };
  walk(condition);
  return values;
}

/**
 * Any drizzle builder step: the service only ever chains and awaits these, so
 * the fakes need nothing more specific than "a bag of callable steps".
 */
type FakeQuery = Record<string, (...args: never[]) => unknown>;

/**
 * A chainable stand-in for a drizzle query builder. `where` narrows by the
 * bound id when the caller passed one, so "read a row by id" and "read a row
 * by another tenant's id" are genuinely different queries here.
 */
function chain(rows: unknown[], allRows: unknown[] = rows): FakeQuery {
  let current = rows;
  const self: FakeQuery = {
    where: (condition?: unknown) => {
      // Only an id predicate narrows here; a tenant predicate is already
      // expressed by what `withTenantTx` made visible.
      const bound = boundValues(condition);
      const ids = bound.filter((value) =>
        allRows.some((row) => (row as { id?: string }).id === value),
      );
      if (ids.length > 0) {
        current = current.filter((row) =>
          ids.includes((row as { id?: string }).id ?? ''),
        );
      }
      return self;
    },
    orderBy: () => self,
    limit: () => self,
    returning: () => self,
    onConflictDoUpdate: () => self,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(current).then(resolve),
  };
  return self;
}

const logLines: string[] = [];

/** A `courier_routes` row (migration 0073): the pre-tenant webhook routing key. */
interface FakeRoute {
  courier: string;
  accountRef: string;
  tenantId: string;
  connectionId: string;
}

function makeHarness(rows: FakeRow[], routes: FakeRoute[] = []) {
  const tenantIds: (string | undefined)[] = [];

  const tenantContext = {
    withTenantTx: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>, tenantId?: string) => {
        tenantIds.push(tenantId);
        const visible = rows.filter((row) => row.tenantId === tenantId);
        const tx = {
          select: () => ({ from: () => chain(visible, rows) }),
          insert: (table: unknown) => ({
            values: (values: Partial<FakeRow> & Partial<FakeRoute>) => {
              if (table === courierRoutes) {
                // Not RLS-scoped: written inside the tenant tx, but the
                // (courier, account_ref) primary key spans every tenant, and
                // onConflictDoUpdate repoints an existing key.
                const route = values as FakeRoute;
                const index = routes.findIndex(
                  (r) =>
                    r.courier === route.courier &&
                    r.accountRef === route.accountRef,
                );
                if (index >= 0) routes[index] = { ...route };
                else routes.push({ ...route });
                return chain([]);
              }
              const existing = rows.find(
                (row) =>
                  row.tenantId === values.tenantId &&
                  row.courier === values.courier &&
                  row.accountRef === values.accountRef,
              );
              if (existing) {
                // onConflictDoUpdate: refresh in place rather than duplicate.
                Object.assign(existing, values, { updatedAt: new Date() });
                return chain([existing]);
              }
              const row = {
                id: `conn-${rows.length + 1}`,
                webhookSecret: null,
                isActive: false,
                lastVerifiedAt: null,
                lastPolledAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...values,
              } as FakeRow;
              rows.push(row);
              return chain([row]);
            },
          }),
          update: () => ({
            set: (patch: Partial<FakeRow>) => {
              let matched = visible;
              const self: FakeQuery = {
                where: (condition: unknown) => {
                  const bound = boundValues(condition);
                  const ids = bound.filter((value) =>
                    rows.some((row) => row.id === value),
                  );
                  matched =
                    ids.length > 0
                      ? visible.filter((row) => ids.includes(row.id))
                      : visible;
                  matched.forEach((row) => Object.assign(row, patch));
                  return self;
                },
                returning: () => self,
                then: (resolve: (value: unknown) => unknown) =>
                  Promise.resolve(matched.map((row) => ({ ...row }))).then(
                    resolve,
                  ),
              };
              return self;
            },
          }),
          delete: (table: unknown) => ({
            where: (condition: unknown) => {
              if (table === courierRoutes) {
                const bound = boundValues(condition);
                for (let i = routes.length - 1; i >= 0; i--) {
                  if (bound.includes(routes[i].connectionId)) {
                    routes.splice(i, 1);
                  }
                }
              }
              return Promise.resolve([]);
            },
          }),
        };
        return fn(tx);
      },
    ),
  } as unknown as TenantContextService;

  // No tenant GUC here, exactly like production: under FORCE RLS the only
  // table this can usefully read is the (non-RLS) routes table, so that is
  // all the fake exposes — a regression back to reading
  // `courier_connections` through runAdminQuery finds nothing.
  const persistence = {
    runAdminQuery: jest.fn((fn: (db: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => {
            let matched = table === courierRoutes ? [...routes] : [];
            const self: FakeQuery = {
              where: (condition: unknown) => {
                const bound = boundValues(condition);
                matched = matched.filter(
                  (r) =>
                    bound.includes(r.courier) && bound.includes(r.accountRef),
                );
                return self;
              },
              limit: () => self,
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve(
                  matched.map((r) => ({
                    tenantId: r.tenantId,
                    connectionId: r.connectionId,
                  })),
                ).then(resolve),
            };
            return self;
          },
        }),
      }),
    ),
  } as unknown as PersistenceService;

  const logger = {
    log: jest.fn((line: string) => logLines.push(line)),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;

  const service = new CourierConnectionService(
    tenantContext,
    persistence,
    new BspCredentialsEncryptionService({
      bspCredentialsEncryptionKey: ENCRYPTION_KEY,
    } as unknown as AppConfigService),
    logger,
  );

  return { service, rows, routes, tenantIds, persistence };
}

beforeEach(() => {
  logLines.length = 0;
});

describe('CourierConnectionService — credentials at rest', () => {
  it('stores ciphertext and returns plaintext on read (round-trip)', async () => {
    const { service, rows } = makeHarness([]);

    const created = await service.upsert({
      tenantId: 'tenant-a',
      courier: 'aramex',
      accountRef: 'ACC-1',
      credentials: { username: 'merchant', password: 's3cret-plaintext' },
      isActive: true,
      webhookSecret: null,
    });

    expect(rows[0].credentials).not.toContain('s3cret-plaintext');
    expect(rows[0].credentials).not.toContain('merchant');
    expect(created.credentials).toEqual({
      username: 'merchant',
      password: 's3cret-plaintext',
    });
  });

  // Plaintext credentials in a log are a review failure, not a follow-up.
  it('never writes a credential into a log line', async () => {
    const { service } = makeHarness([]);

    await service.upsert({
      tenantId: 'tenant-a',
      courier: 'smsa',
      accountRef: 'ACC-2',
      credentials: { apiKey: 'smsa-key-plaintext' },
      isActive: true,
    });

    expect(logLines.join('\n')).not.toContain('smsa-key-plaintext');
    expect(logLines.join('\n')).toContain('smsa');
  });

  it('round-trips the webhook secret through the same cipher', async () => {
    const { service, rows } = makeHarness([]);

    await service.upsert({
      tenantId: 'tenant-a',
      courier: 'jt',
      accountRef: 'ACC-3',
      credentials: { apiAccount: 'a', privateKey: 'k' },
      isActive: true,
      webhookSecret: 'whsec-plaintext',
    });

    expect(rows[0].webhookSecret).not.toContain('whsec-plaintext');
    const [read] = await service.findByTenant('tenant-a');
    expect(read.webhookSecret).toBe('whsec-plaintext');
  });

  // Re-entering credentials for the same (courier, account) must refresh the
  // row, not 500 on a duplicate key.
  it('upserts rather than duplicate-keying on reconnect', async () => {
    const rows: FakeRow[] = [];
    const { service } = makeHarness(rows);

    await service.upsert({
      tenantId: 'tenant-a',
      courier: 'aramex',
      accountRef: 'ACC-1',
      credentials: { password: 'old' },
      isActive: false,
    });
    const second = await service.upsert({
      tenantId: 'tenant-a',
      courier: 'aramex',
      accountRef: 'ACC-1',
      credentials: { password: 'new' },
      isActive: true,
    });

    expect(rows).toHaveLength(1);
    expect(second.credentials.password).toBe('new');
    expect(second.isActive).toBe(true);
  });
});

describe('CourierConnectionService — tenant isolation', () => {
  function twoTenants() {
    const encryption = new BspCredentialsEncryptionService({
      bspCredentialsEncryptionKey: ENCRYPTION_KEY,
    } as unknown as AppConfigService);
    const rows: FakeRow[] = [
      {
        id: 'conn-a',
        tenantId: 'tenant-a',
        courier: 'aramex',
        credentials: encryption.encrypt({ password: 'a' }),
        accountRef: 'SHARED-REF',
        webhookSecret: null,
        isActive: true,
        lastVerifiedAt: null,
        lastPolledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'conn-b',
        tenantId: 'tenant-b',
        courier: 'aramex',
        credentials: encryption.encrypt({ password: 'b' }),
        accountRef: 'OTHER-REF',
        webhookSecret: null,
        isActive: true,
        lastVerifiedAt: null,
        lastPolledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    return makeHarness(rows);
  }

  it("does not return another tenant's connection by id", async () => {
    const { service } = twoTenants();

    expect(await service.findById('tenant-a', 'conn-b')).toBeNull();
    expect(await service.findById('tenant-a', 'conn-a')).not.toBeNull();
  });

  it("cannot deactivate another tenant's connection", async () => {
    const { service, rows } = twoTenants();

    expect(await service.deactivate('tenant-a', 'conn-b')).toBe(false);
    expect(rows.find((r) => r.id === 'conn-b')?.isActive).toBe(true);
  });

  it("cannot rotate another tenant's webhook secret", async () => {
    const { service } = twoTenants();

    expect(await service.rotateWebhookSecret('tenant-a', 'conn-b')).toBeNull();
  });

  it('enters a tenant transaction for every tenant-scoped read and write', async () => {
    const { service, tenantIds } = twoTenants();

    await service.findByTenant('tenant-a');
    await service.markPolled('tenant-a', 'conn-a');

    expect(tenantIds.every((id) => id === 'tenant-a')).toBe(true);
  });
});

// QA 2026-10-05: "aramex rejected your credentials" / "tracking has been
// failing" are stale once credentials for that same connection verify again.
describe('CourierConnectionService.upsert — retiring a stale failure notification', () => {
  const resolveMock = jest.mocked(markEntityNotificationsRead);
  beforeEach(() => resolveMock.mockClear());

  it('retires courier_connection_failing for the connection when the new credentials verified', async () => {
    const { service } = makeHarness([]);

    const connection = await service.upsert({
      tenantId: 'tenant-a',
      courier: 'aramex',
      accountRef: 'ACC-1',
      credentials: { password: 'fixed' },
      isActive: true,
    });

    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      entityType: 'courier_connection',
      entityIds: [connection.id],
      kinds: ['courier_connection_failing'],
      readAt: expect.any(Date) as unknown,
    });
  });

  it('keeps it when the credentials were saved but did not verify', async () => {
    const { service } = makeHarness([]);

    await service.upsert({
      tenantId: 'tenant-a',
      courier: 'aramex',
      accountRef: 'ACC-1',
      credentials: { password: 'still-wrong' },
      isActive: false,
    });

    expect(resolveMock).not.toHaveBeenCalled();
  });
});

// Clarly 2.0 RLS fix: `courier_connections` is FORCE RLS, so a courier push
// (no tenant) resolves its tenant through `courier_routes`, which this
// service keeps equal to the active connections in the same transaction.
describe('CourierConnectionService — courier_routes maintenance', () => {
  const encryption = new BspCredentialsEncryptionService({
    bspCredentialsEncryptionKey: ENCRYPTION_KEY,
  } as unknown as AppConfigService);

  function activeRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: 'conn-a',
      tenantId: 'tenant-a',
      courier: 'jt',
      credentials: encryption.encrypt({ password: 'a' }),
      accountRef: 'ACC-A',
      webhookSecret: null,
      isActive: true,
      lastVerifiedAt: null,
      lastPolledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it('writes the route when a connection is activated', async () => {
    const { service, routes } = makeHarness([]);

    const connection = await service.upsert({
      tenantId: 'tenant-a',
      courier: 'jt',
      accountRef: 'ACC-1',
      credentials: { apiAccount: 'a', privateKey: 'k' },
      isActive: true,
    });

    expect(routes).toEqual([
      {
        courier: 'jt',
        accountRef: 'ACC-1',
        tenantId: 'tenant-a',
        connectionId: connection.id,
      },
    ]);
  });

  it('writes no route for credentials that were saved but did not verify', async () => {
    const { service, routes } = makeHarness([]);

    await service.upsert({
      tenantId: 'tenant-a',
      courier: 'jt',
      accountRef: 'ACC-1',
      credentials: { apiAccount: 'a', privateKey: 'k' },
      isActive: false,
    });

    expect(routes).toEqual([]);
  });

  it('drops the route when a reconnect fails verification', async () => {
    const { service, routes } = makeHarness(
      [activeRow()],
      [
        {
          courier: 'jt',
          accountRef: 'ACC-A',
          tenantId: 'tenant-a',
          connectionId: 'conn-a',
        },
      ],
    );

    await service.upsert({
      tenantId: 'tenant-a',
      courier: 'jt',
      accountRef: 'ACC-A',
      credentials: { apiAccount: 'a', privateKey: 'wrong' },
      isActive: false,
    });

    expect(routes).toEqual([]);
  });

  it('deletes the route when the connection is deactivated', async () => {
    const { service, routes } = makeHarness(
      [activeRow()],
      [
        {
          courier: 'jt',
          accountRef: 'ACC-A',
          tenantId: 'tenant-a',
          connectionId: 'conn-a',
        },
      ],
    );

    expect(await service.deactivate('tenant-a', 'conn-a')).toBe(true);
    expect(routes).toEqual([]);
  });

  it('deletes the route when the courier rejects the credentials', async () => {
    const { service, routes, rows } = makeHarness(
      [activeRow()],
      [
        {
          courier: 'jt',
          accountRef: 'ACC-A',
          tenantId: 'tenant-a',
          connectionId: 'conn-a',
        },
      ],
    );

    await service.markCredentialsRejected('tenant-a', 'conn-a');

    expect(rows[0].isActive).toBe(false);
    expect(routes).toEqual([]);
  });

  it("leaves another tenant's route alone when asked to deactivate its connection", async () => {
    const route = {
      courier: 'jt',
      accountRef: 'ACC-B',
      tenantId: 'tenant-b',
      connectionId: 'conn-b',
    };
    const { service, routes } = makeHarness(
      [activeRow({ id: 'conn-b', tenantId: 'tenant-b', accountRef: 'ACC-B' })],
      [route],
    );

    expect(await service.deactivate('tenant-a', 'conn-b')).toBe(false);
    expect(routes).toEqual([route]);
  });
});

describe('CourierConnectionService.findByRoutingKey', () => {
  const encryption = new BspCredentialsEncryptionService({
    bspCredentialsEncryptionKey: ENCRYPTION_KEY,
  } as unknown as AppConfigService);

  function row(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: 'conn-b',
      tenantId: 'tenant-b',
      courier: 'jt',
      credentials: encryption.encrypt({ password: 'b' }),
      accountRef: 'ACC-B',
      webhookSecret: null,
      isActive: true,
      lastVerifiedAt: null,
      lastPolledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  const route: FakeRoute = {
    courier: 'jt',
    accountRef: 'ACC-B',
    tenantId: 'tenant-b',
    connectionId: 'conn-b',
  };

  it('learns the tenant from the route, then loads the connection under that tenant', async () => {
    const { service, tenantIds } = makeHarness([row()], [{ ...route }]);

    const connection = await service.findByRoutingKey('jt', 'ACC-B');

    expect(connection).toMatchObject({
      id: 'conn-b',
      tenantId: 'tenant-b',
      accountRef: 'ACC-B',
    });
    expect(tenantIds).toEqual(['tenant-b']);
  });

  it('returns null when no route exists for the key', async () => {
    const { service, tenantIds } = makeHarness([row()], []);

    expect(await service.findByRoutingKey('jt', 'ACC-B')).toBeNull();
    // Nothing to enter — the tenant is unknown.
    expect(tenantIds).toEqual([]);
  });

  it('returns null when the routed connection is no longer active', async () => {
    const { service } = makeHarness([row({ isActive: false })], [{ ...route }]);

    expect(await service.findByRoutingKey('jt', 'ACC-B')).toBeNull();
  });

  it('returns null when the routed connection no longer owns the key', async () => {
    const { service } = makeHarness(
      [row({ accountRef: 'ACC-RENAMED' })],
      [{ ...route }],
    );

    expect(await service.findByRoutingKey('jt', 'ACC-B')).toBeNull();
  });

  it('returns null when the routed connection is gone', async () => {
    const { service } = makeHarness([], [{ ...route }]);

    expect(await service.findByRoutingKey('jt', 'ACC-B')).toBeNull();
  });
});
