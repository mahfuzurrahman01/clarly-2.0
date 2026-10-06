// F24: tenant-isolation and token-encryption regression tests.
//
// The fake transaction below emulates the one property RLS gives us: inside
// `withTenantTx(fn, tenantId)` only rows belonging to `tenantId` are visible.
// That is exactly what the first cut lost by injecting a raw db handle and
// querying outside any tenant transaction — so these tests fail loudly if
// anyone reverts to a non-tenant-scoped read/write.
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import type { AppConfigService } from '../core';
import type { AppLoggerService } from '../core';
import { storeRoutes } from '../persistence/drizzle/schema';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { StoreConnectionService } from './store-connection.service';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

interface FakeRow {
  id: string;
  tenantId: string;
  provider: string;
  storeId: string;
  storeName: string;
  storeUrl: string | null;
  accessToken: string;
  refreshToken: string | null;
  authorizationToken: string | null;
  tokenExpiresAt: Date | null;
  webhookSecret: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeEncryption(): BspCredentialsEncryptionService {
  return new BspCredentialsEncryptionService({
    bspCredentialsEncryptionKey: ENCRYPTION_KEY,
  } as unknown as AppConfigService);
}

function makeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

/** A `store_routes` row (migration 0073): the pre-tenant webhook routing key. */
interface FakeRoute {
  provider: string;
  storeId: string;
  tenantId: string;
  connectionId: string;
}

/** The literal values bound into a drizzle `eq(...)`/`and(...)` condition. */
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

/** Chainable, awaitable stand-in for a drizzle query builder. */
function chain(rows: FakeRow[] | { id: string }[]): FakeQuery {
  const self: FakeQuery = {
    where: () => self,
    orderBy: () => self,
    limit: () => self,
    returning: () => self,
    onConflictDoUpdate: () => self,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return self;
}

function makeHarness(rows: FakeRow[], routes: FakeRoute[] = []) {
  const tenantIds: (string | undefined)[] = [];

  const tenantContext = {
    withTenantTx: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>, tenantId?: string) => {
        tenantIds.push(tenantId);
        // RLS emulation: only this tenant's rows exist inside the transaction.
        const visible = rows.filter((row) => row.tenantId === tenantId);
        const tx = {
          select: () => ({ from: () => chain(visible) }),
          insert: (table: unknown) => ({
            values: (values: Partial<FakeRow> & Partial<FakeRoute>) => {
              if (table === storeRoutes) {
                // Not RLS-scoped: the (provider, store_id) key spans every
                // tenant, and onConflictDoUpdate hands it to the newest
                // connect.
                const route = values as FakeRoute;
                const index = routes.findIndex(
                  (r) =>
                    r.provider === route.provider &&
                    r.storeId === route.storeId,
                );
                if (index >= 0) routes[index] = { ...route };
                else routes.push({ ...route });
                return chain([]);
              }
              const defaults = {
                id: `conn-${rows.length + 1}`,
                storeUrl: null,
                refreshToken: null,
                authorizationToken: null,
                tokenExpiresAt: null,
                webhookSecret: null,
                isActive: true,
                lastSyncedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              const row = { ...defaults, ...values } as FakeRow;
              rows.push(row);
              return chain([row]);
            },
          }),
          update: () => ({
            set: (patch: Partial<FakeRow>) => {
              visible.forEach((row) => Object.assign(row, patch));
              return chain(visible.map((row) => ({ ...row })));
            },
          }),
          delete: (table: unknown) => ({
            where: (condition: unknown) => {
              if (table === storeRoutes) {
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

  // No tenant GUC, exactly like production: under FORCE RLS only the
  // (non-RLS) routes table is readable here, so that is all the fake exposes.
  const persistence = {
    runAdminQuery: jest.fn((fn: (db: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => {
            let matched = table === storeRoutes ? [...routes] : [];
            const self: FakeQuery = {
              where: (condition: unknown) => {
                const bound = boundValues(condition);
                matched = matched.filter(
                  (r) =>
                    bound.includes(r.provider) && bound.includes(r.storeId),
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

  const service = new StoreConnectionService(
    tenantContext,
    persistence,
    makeEncryption(),
    makeLogger(),
  );

  return { service, tenantContext, tenantIds, rows, routes };
}

describe('StoreConnectionService', () => {
  describe('token encryption', () => {
    it('stores ciphertext and returns plaintext on read (round-trip)', async () => {
      const { service, rows } = makeHarness([]);

      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'salla_access_token_plaintext',
        refreshToken: 'salla_refresh_token_plaintext',
        webhookSecret: 'whsec_plaintext',
      });

      const stored = rows[0];
      expect(stored.accessToken).not.toContain('plaintext');
      expect(stored.refreshToken).not.toContain('plaintext');
      expect(stored.webhookSecret).not.toContain('plaintext');

      expect(created.accessToken).toBe('salla_access_token_plaintext');
      expect(created.refreshToken).toBe('salla_refresh_token_plaintext');
      expect(created.webhookSecret).toBe('whsec_plaintext');

      const readBack = await service.findById('tenant-a', stored.id);
      expect(readBack?.accessToken).toBe('salla_access_token_plaintext');
      expect(readBack?.webhookSecret).toBe('whsec_plaintext');
    });

    it('re-encrypts on token refresh rather than writing the new token in the clear', async () => {
      const { service, rows } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'zid',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'old_token',
      });

      await service.updateTokens('tenant-a', created.id, {
        accessToken: 'rotated_token_plaintext',
        refreshToken: 'rotated_refresh_plaintext',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      });

      expect(rows[0].accessToken).not.toContain('rotated_token_plaintext');
      const readBack = await service.findById('tenant-a', created.id);
      expect(readBack?.accessToken).toBe('rotated_token_plaintext');
      expect(readBack?.refreshToken).toBe('rotated_refresh_plaintext');
    });
    it("encrypts Zid's partner authorization token and keeps it across a refresh that returns none", async () => {
      const { service, rows } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'zid',
        storeId: '3',
        storeName: 'Zid Store',
        accessToken: 'manager_token',
        authorizationToken: 'partner_auth_plaintext',
      });

      expect(rows[0].authorizationToken).not.toContain('plaintext');
      expect(created.authorizationToken).toBe('partner_auth_plaintext');

      await service.updateTokens('tenant-a', created.id, {
        accessToken: 'manager_token_2',
      });
      const kept = await service.findById('tenant-a', created.id);
      expect(kept?.authorizationToken).toBe('partner_auth_plaintext');

      await service.updateTokens('tenant-a', created.id, {
        accessToken: 'manager_token_3',
        authorizationToken: 'partner_auth_rotated_plaintext',
      });
      expect(rows[0].authorizationToken).not.toContain('plaintext');
      const rotated = await service.findById('tenant-a', created.id);
      expect(rotated?.authorizationToken).toBe(
        'partner_auth_rotated_plaintext',
      );
    });

    it('reads a missing authorization token as null (Salla, Shopify, WooCommerce)', async () => {
      const { service } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token',
      });
      expect(created.authorizationToken).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it("never returns another tenant's connection by id", async () => {
      const { service, tenantIds } = makeHarness([]);
      const owned = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });

      await expect(service.findById('tenant-b', owned.id)).resolves.toBeNull();
      // The GUC the RLS policy reads is set from this argument — a read that
      // passed no tenantId (or the wrong one) would be the actual bug.
      expect(tenantIds).toContain('tenant-b');
    });

    it("cannot disconnect another tenant's connection", async () => {
      const { service } = makeHarness([]);
      const owned = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });

      await expect(
        service.markDisconnected('tenant-b', owned.id),
      ).resolves.toBe(false);
      await expect(
        service.markDisconnected('tenant-a', owned.id),
      ).resolves.toBe(true);
    });

    it("cannot rotate another tenant's webhook secret", async () => {
      const { service } = makeHarness([]);
      const owned = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
        webhookSecret: 'whsec_original',
      });

      await expect(
        service.rotateWebhookSecret('tenant-b', owned.id),
      ).resolves.toBeNull();

      const rotated = await service.rotateWebhookSecret('tenant-a', owned.id);
      expect(rotated).toHaveLength(64);
      await expect(
        service.findById('tenant-a', owned.id).then((c) => c?.webhookSecret),
      ).resolves.toBe(rotated);
    });

    it('lists only the calling tenant’s connections', async () => {
      const { service } = makeHarness([]);
      await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });
      await service.create({
        tenantId: 'tenant-b',
        provider: 'zid',
        storeId: 'store-2',
        storeName: 'B Store',
        accessToken: 'token-b',
      });

      const forA = await service.findByTenant('tenant-a');
      expect(forA).toHaveLength(1);
      expect(forA[0].storeName).toBe('A Store');
    });
  });

  // Clarly 2.0 RLS fix: `store_connections` is FORCE RLS, so a store webhook
  // (no tenant) resolves its tenant through `store_routes`, which this service
  // keeps equal to the active connections in the same transaction.
  describe('store_routes maintenance', () => {
    it('writes the route when a store is connected', async () => {
      const { service, routes } = makeHarness([]);

      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });

      expect(routes).toEqual([
        {
          provider: 'salla',
          storeId: 'store-1',
          tenantId: 'tenant-a',
          connectionId: created.id,
        },
      ]);
    });

    it('hands the route to the most recent connect of the same store', async () => {
      const { service, routes } = makeHarness([]);
      await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });

      const newer = await service.create({
        tenantId: 'tenant-b',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'Same store, new owner',
        accessToken: 'token-b',
      });

      expect(routes).toEqual([
        {
          provider: 'salla',
          storeId: 'store-1',
          tenantId: 'tenant-b',
          connectionId: newer.id,
        },
      ]);
    });

    it('deletes the route when the store is disconnected', async () => {
      const { service, routes } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });

      await expect(
        service.markDisconnected('tenant-a', created.id),
      ).resolves.toBe(true);
      expect(routes).toEqual([]);
    });

    it('leaves the route alone when another tenant tries to disconnect it', async () => {
      const { service, routes } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });

      await expect(
        service.markDisconnected('tenant-b', created.id),
      ).resolves.toBe(false);
      expect(routes).toHaveLength(1);
      expect(routes[0].connectionId).toBe(created.id);
    });

    it('keeps the newer owner’s route when the superseded connection disconnects', async () => {
      const { service, routes } = makeHarness([]);
      const older = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });
      const newer = await service.create({
        tenantId: 'tenant-b',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'Same store, new owner',
        accessToken: 'token-b',
      });

      await service.markDisconnected('tenant-a', older.id);

      expect(routes).toEqual([
        expect.objectContaining({
          tenantId: 'tenant-b',
          connectionId: newer.id,
        }),
      ]);
    });
  });

  describe('findByProviderAndStoreId', () => {
    it('learns the tenant from the route, then loads the connection under that tenant', async () => {
      const { service, tenantIds } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'zid',
        storeId: 'store-9',
        storeName: 'A Store',
        accessToken: 'token-a',
        webhookSecret: 'whsec_a',
      });
      tenantIds.length = 0;

      const found = await service.findByProviderAndStoreId('zid', 'store-9');

      expect(found).toMatchObject({
        id: created.id,
        tenantId: 'tenant-a',
        webhookSecret: 'whsec_a',
      });
      expect(tenantIds).toEqual(['tenant-a']);
    });

    it('returns null when no route exists for the store', async () => {
      const { service, tenantIds } = makeHarness([]);

      await expect(
        service.findByProviderAndStoreId('salla', 'unknown-store'),
      ).resolves.toBeNull();
      // Nothing to enter — the tenant is unknown.
      expect(tenantIds).toEqual([]);
    });

    it('returns null once the store has been disconnected', async () => {
      const { service } = makeHarness([]);
      const created = await service.create({
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        accessToken: 'token-a',
      });
      await service.markDisconnected('tenant-a', created.id);

      await expect(
        service.findByProviderAndStoreId('salla', 'store-1'),
      ).resolves.toBeNull();
    });

    it('returns null when the routed connection is inactive or no longer owns the key', async () => {
      const encrypted = makeEncryption().encrypt({ value: 'token' });
      const base: FakeRow = {
        id: 'conn-x',
        tenantId: 'tenant-a',
        provider: 'salla',
        storeId: 'store-1',
        storeName: 'A Store',
        storeUrl: null,
        accessToken: encrypted,
        refreshToken: null,
        authorizationToken: null,
        tokenExpiresAt: null,
        webhookSecret: null,
        isActive: false,
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const route: FakeRoute = {
        provider: 'salla',
        storeId: 'store-1',
        tenantId: 'tenant-a',
        connectionId: 'conn-x',
      };

      const inactive = makeHarness([{ ...base }], [{ ...route }]);
      await expect(
        inactive.service.findByProviderAndStoreId('salla', 'store-1'),
      ).resolves.toBeNull();

      const moved = makeHarness(
        [{ ...base, isActive: true, storeId: 'store-2' }],
        [{ ...route }],
      );
      await expect(
        moved.service.findByProviderAndStoreId('salla', 'store-1'),
      ).resolves.toBeNull();
    });
  });
});
