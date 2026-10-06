// Feature 24 (Store Integrations): CRUD service for store_connections.
//
// Two corrections over the first cut, both load-bearing:
//
//  1. DI — it injected `PostgresJsDatabase`, a token nothing in this app
//     provides (the app is NodePgDatabase behind PersistenceModule's
//     DRIZZLE_DB), so StoreModule could not instantiate. Tenant-scoped reads
//     and writes now go through `TenantContextService.withTenantTx()` like
//     every other tenant table, which is also what sets `app.tenant_id` and
//     therefore what makes `store_connections`' RLS policy apply at all.
//     Talking to the pool directly, as it did, bypassed RLS entirely.
//
//  2. Secrets at rest — `access_token` / `refresh_token` / `webhook_secret`
//     (and, since 0066, Zid's `authorization_token`) were plaintext. They are now AES-256-GCM blobs via
//     `BspCredentialsEncryptionService`, the same cipher `social_channels`
//     credentials use (one crypto path to audit, one key to rotate).
//
// The two genuinely pre-tenant reads (webhook routing by store id, and the
// platform-wide sync sweep) are explicitly marked and use
// `PersistenceService.runAdminQuery` with an explicit predicate, the same
// carve-out SocialChannelDirectory documents.
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { storeConnections, storeRoutes } from '../persistence/drizzle/schema';
import type { DrizzleDb } from '../persistence/persistence.providers';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import { AppLoggerService } from '../core';
import type { StoreProviderName } from './store-provider-name';

export interface StoreConnection {
  id: string;
  tenantId: string;
  provider: StoreProviderName;
  storeId: string;
  storeName: string;
  storeUrl: string | null;
  /** Decrypted. Never log, never return over HTTP. */
  accessToken: string;
  /** Decrypted. Never log, never return over HTTP. */
  refreshToken: string | null;
  /** Decrypted. Zid's partner `authorization` token; null for every other provider. Never log, never return over HTTP. */
  authorizationToken: string | null;
  tokenExpiresAt: Date | null;
  /** Decrypted. Only ever returned to the owning tenant through the explicit rotate endpoint. */
  webhookSecret: string | null;
  isActive: boolean;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStoreConnectionInput {
  tenantId: string;
  provider: StoreProviderName;
  storeId: string;
  storeName: string;
  storeUrl?: string;
  accessToken: string;
  refreshToken?: string;
  /** Zid only. */
  authorizationToken?: string;
  tokenExpiresAt?: Date;
  webhookSecret?: string;
}

/** Shape as stored — secrets are ciphertext here. */
interface StoreConnectionRow {
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

const SECRET_FIELD = 'value';

@Injectable()
export class StoreConnectionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly persistence: PersistenceService,
    private readonly encryption: BspCredentialsEncryptionService,
    private readonly logger: AppLoggerService,
  ) {}

  /** A fresh per-connection webhook secret the merchant pastes into their store's webhook settings. */
  static generateWebhookSecret(): string {
    return randomBytes(32).toString('hex');
  }

  private encryptSecret(value: string): string {
    return this.encryption.encrypt({ [SECRET_FIELD]: value });
  }

  private decryptSecret(blob: string | null): string | null {
    if (!blob) return null;
    const decrypted = this.encryption.decrypt(blob)[SECRET_FIELD];
    return typeof decrypted === 'string' ? decrypted : null;
  }

  private toConnection(row: StoreConnectionRow): StoreConnection {
    return {
      ...row,
      provider: row.provider as StoreProviderName,
      accessToken: this.decryptSecret(row.accessToken) ?? '',
      refreshToken: this.decryptSecret(row.refreshToken),
      authorizationToken: this.decryptSecret(row.authorizationToken),
      webhookSecret: this.decryptSecret(row.webhookSecret),
    };
  }

  /**
   * Insert, or update in place when this tenant reconnects the same store
   * (the (tenant_id, provider, store_id) unique key). Reconnecting must
   * refresh the credentials, not 500 on a duplicate-key error.
   */
  async create(input: CreateStoreConnectionInput): Promise<StoreConnection> {
    const encrypted = {
      accessToken: this.encryptSecret(input.accessToken),
      refreshToken: input.refreshToken
        ? this.encryptSecret(input.refreshToken)
        : null,
      authorizationToken: input.authorizationToken
        ? this.encryptSecret(input.authorizationToken)
        : null,
      webhookSecret: input.webhookSecret
        ? this.encryptSecret(input.webhookSecret)
        : null,
    };

    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .insert(storeConnections)
        .values({
          tenantId: input.tenantId,
          provider: input.provider,
          storeId: input.storeId,
          storeName: input.storeName,
          storeUrl: input.storeUrl ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          isActive: true,
          ...encrypted,
        })
        .onConflictDoUpdate({
          target: [
            storeConnections.tenantId,
            storeConnections.provider,
            storeConnections.storeId,
          ],
          set: {
            storeName: input.storeName,
            storeUrl: input.storeUrl ?? null,
            tokenExpiresAt: input.tokenExpiresAt ?? null,
            isActive: true,
            updatedAt: new Date(),
            ...encrypted,
          },
        })
        .returning();
      if (rows[0]) await syncStoreRoute(tx, rows[0]);
      return rows;
    }, input.tenantId);

    this.logger.log(
      `Store connection upserted: ${row.id} (${input.provider}) for tenant ${input.tenantId}`,
      'StoreConnectionService',
    );
    return this.toConnection(row);
  }

  /** Tenant-scoped by argument AND by RLS — a connection id from another workspace resolves to null. */
  async findById(
    tenantId: string,
    id: string,
  ): Promise<StoreConnection | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(storeConnections)
          .where(
            and(
              eq(storeConnections.id, id),
              eq(storeConnections.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? this.toConnection(rows[0]) : null;
  }

  async findByTenant(tenantId: string): Promise<StoreConnection[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(storeConnections)
          .where(eq(storeConnections.tenantId, tenantId))
          .orderBy(desc(storeConnections.createdAt), asc(storeConnections.id)),
      tenantId,
    );
    return (rows as StoreConnectionRow[]).map((row) => this.toConnection(row));
  }

  /**
   * The tenant's active connections, newest connection first with a stable id
   * tie-break. The ordering is the contract CreateOrderExecutor relies on to
   * pick a store deterministically — `Array.find()` over an unordered query,
   * which is what it did before, can send two identical orders to two
   * different stores.
   */
  async findActiveByTenant(tenantId: string): Promise<StoreConnection[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(storeConnections)
          .where(
            and(
              eq(storeConnections.tenantId, tenantId),
              eq(storeConnections.isActive, true),
            ),
          )
          .orderBy(desc(storeConnections.createdAt), asc(storeConnections.id)),
      tenantId,
    );
    return (rows as StoreConnectionRow[]).map((row) => this.toConnection(row));
  }

  async findByTenantAndProvider(
    tenantId: string,
    provider: StoreProviderName,
  ): Promise<StoreConnection | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(storeConnections)
          .where(
            and(
              eq(storeConnections.tenantId, tenantId),
              eq(storeConnections.provider, provider),
            ),
          )
          .orderBy(desc(storeConnections.createdAt), asc(storeConnections.id))
          .limit(1),
      tenantId,
    );
    return rows[0] ? this.toConnection(rows[0]) : null;
  }

  async updateTokens(
    tenantId: string,
    id: string,
    tokens: {
      accessToken: string;
      refreshToken?: string | null;
      /** Undefined leaves the stored value untouched (most providers have none). */
      authorizationToken?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(storeConnections)
          .set({
            accessToken: this.encryptSecret(tokens.accessToken),
            ...(tokens.refreshToken === undefined
              ? {}
              : {
                  refreshToken: tokens.refreshToken
                    ? this.encryptSecret(tokens.refreshToken)
                    : null,
                }),
            ...(tokens.authorizationToken === undefined
              ? {}
              : {
                  authorizationToken: tokens.authorizationToken
                    ? this.encryptSecret(tokens.authorizationToken)
                    : null,
                }),
            tokenExpiresAt: tokens.expiresAt ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(storeConnections.id, id),
              eq(storeConnections.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  /** Rotates (or sets) the per-connection webhook secret. Returns the plaintext once — it is never readable again. */
  async rotateWebhookSecret(
    tenantId: string,
    id: string,
  ): Promise<string | null> {
    const secret = StoreConnectionService.generateWebhookSecret();
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(storeConnections)
          .set({
            webhookSecret: this.encryptSecret(secret),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(storeConnections.id, id),
              eq(storeConnections.tenantId, tenantId),
            ),
          )
          .returning({ id: storeConnections.id }),
      tenantId,
    );
    return rows.length > 0 ? secret : null;
  }

  /** @returns false when nothing matched (unknown id, or another tenant's). */
  async markDisconnected(tenantId: string, id: string): Promise<boolean> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(storeConnections)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(storeConnections.id, id),
            eq(storeConnections.tenantId, tenantId),
          ),
        )
        .returning();
      if (rows[0]) await syncStoreRoute(tx, rows[0]);
      return rows.length > 0;
    }, tenantId);
  }

  async markSynced(tenantId: string, id: string): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(storeConnections)
          .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(storeConnections.id, id),
              eq(storeConnections.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  /**
   * Re-derives this tenant's webhook routes from its active connections.
   * For connections that existed before the routes table (migration 0073):
   * `pnpm --filter api run routes:backfill` calls this for every tenant.
   * Idempotent. Returns how many active connections now have a route.
   */
  async rebuildRoutes(tenantId: string): Promise<number> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(storeConnections)
        .where(
          and(
            eq(storeConnections.tenantId, tenantId),
            eq(storeConnections.isActive, true),
          ),
        )
        .orderBy(asc(storeConnections.createdAt));
      // Oldest first, so for stores the newest connect ends up holding the
      // route, as it would have at connect time.
      for (const row of rows) await syncStoreRoute(tx, row);
      return rows.length;
    }, tenantId);
  }

  /**
   * PRE-TENANT read: a store webhook arrives with no tenant JWT — the
   * (provider, store_id) pair IS the routing key, exactly like WhatsApp
   * number resolution. The tenant comes from `store_routes` (not RLS-scoped,
   * no secrets; the most recent connect of a store owns it); the connection
   * and its secret are then read under that tenant and must still be active.
   * Reading `store_connections` here directly returns nothing under FORCE
   * RLS — every store webhook was rejected (Clarly 2.0 fix).
   */
  async findByProviderAndStoreId(
    provider: StoreProviderName,
    storeId: string,
  ): Promise<StoreConnection | null> {
    const [route] = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          tenantId: storeRoutes.tenantId,
          connectionId: storeRoutes.connectionId,
        })
        .from(storeRoutes)
        .where(
          and(
            eq(storeRoutes.provider, provider),
            eq(storeRoutes.storeId, storeId),
          ),
        )
        .limit(1),
    );
    if (!route) return null;
    const connection = await this.findById(route.tenantId, route.connectionId);
    if (
      !connection ||
      !connection.isActive ||
      connection.provider !== provider ||
      connection.storeId !== storeId
    ) {
      return null;
    }
    return connection;
  }
}

/**
 * Keeps `store_routes` equal to the active connections, inside the caller's
 * tenant transaction (the routes table is not RLS-scoped). The latest connect
 * of a store takes the route, as the newest-row rule did before; a disconnect
 * only removes the route if this connection still holds it.
 */
async function syncStoreRoute(
  tx: DrizzleDb,
  row: Pick<
    StoreConnectionRow,
    'id' | 'tenantId' | 'provider' | 'storeId' | 'isActive'
  >,
): Promise<void> {
  if (!row.isActive) {
    await tx.delete(storeRoutes).where(eq(storeRoutes.connectionId, row.id));
    return;
  }
  // A connection holds at most one route (unique connection_id); clear any
  // stale one first so the upsert below cannot collide on it.
  await tx.delete(storeRoutes).where(eq(storeRoutes.connectionId, row.id));
  await tx
    .insert(storeRoutes)
    .values({
      provider: row.provider,
      storeId: row.storeId,
      tenantId: row.tenantId,
      connectionId: row.id,
    })
    .onConflictDoUpdate({
      target: [storeRoutes.provider, storeRoutes.storeId],
      set: {
        tenantId: row.tenantId,
        connectionId: row.id,
        updatedAt: new Date(),
      },
    });
}
