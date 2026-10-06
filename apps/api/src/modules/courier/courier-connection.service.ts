// F26 (Delivery Tracking): CRUD for `courier_connections` (D1/D7).
//
// Credentials at rest are ONE AES-256-GCM blob produced by
// `BspCredentialsEncryptionService` — the same cipher and the same key
// `social_channels` and `store_connections` use. One crypto path to audit,
// one key to rotate, and adding a courier never adds a column. Plaintext
// credentials here would be a review failure, not a follow-up.
//
// DI is `TenantContextService` + `PersistenceService`, never a raw DB handle:
// `withTenantTx()` is what sets `app.tenant_id` and therefore what makes this
// table's RLS policy apply at all. The only two `runAdminQuery` uses are the
// genuinely pre-tenant reads (webhook routing, the poll sweep's connection
// scan); both are marked and both carry an explicit predicate.
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  courierConnections,
  courierRoutes,
} from '../persistence/drizzle/schema';
import type { DrizzleDb } from '../persistence/persistence.providers';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import { AppLoggerService } from '../core';
import type { CourierName } from './ports/courier-connector.port';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';

export interface CourierConnection {
  id: string;
  tenantId: string;
  courier: CourierName;
  accountRef: string;
  /** Decrypted. Never log, never return over HTTP. */
  credentials: Record<string, string>;
  /** Decrypted. Only ever returned to the owning tenant through the explicit rotate endpoint. */
  webhookSecret: string | null;
  isActive: boolean;
  lastVerifiedAt: Date | null;
  lastPolledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertCourierConnectionInput {
  tenantId: string;
  courier: CourierName;
  accountRef: string;
  credentials: Record<string, string>;
  isActive: boolean;
  webhookSecret?: string | null;
}

interface CourierConnectionRow {
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

const SECRET_FIELD = 'value';

@Injectable()
export class CourierConnectionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly persistence: PersistenceService,
    private readonly encryption: BspCredentialsEncryptionService,
    private readonly logger: AppLoggerService,
  ) {}

  /** A fresh per-connection webhook secret the merchant registers with the courier. */
  static generateWebhookSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Insert, or update in place when this tenant re-enters credentials for the
   * same (courier, account_ref). Re-connecting must refresh the credentials,
   * not 500 on a duplicate-key error.
   */
  async upsert(
    input: UpsertCourierConnectionInput,
  ): Promise<CourierConnection> {
    const credentials = this.encryption.encrypt(input.credentials);
    const webhookSecret =
      input.webhookSecret === undefined
        ? undefined
        : input.webhookSecret === null
          ? null
          : this.encryptSecret(input.webhookSecret);

    const now = new Date();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .insert(courierConnections)
        .values({
          tenantId: input.tenantId,
          courier: input.courier,
          accountRef: input.accountRef,
          credentials,
          isActive: input.isActive,
          lastVerifiedAt: input.isActive ? now : null,
          ...(webhookSecret === undefined ? {} : { webhookSecret }),
        })
        .onConflictDoUpdate({
          target: [
            courierConnections.tenantId,
            courierConnections.courier,
            courierConnections.accountRef,
          ],
          set: {
            credentials,
            isActive: input.isActive,
            lastVerifiedAt: input.isActive ? now : null,
            updatedAt: now,
            ...(webhookSecret === undefined ? {} : { webhookSecret }),
          },
        })
        .returning();
      if (rows[0]) await syncCourierRoute(tx, rows[0]);
      // QA 2026-10-05: credentials that just verified make "rejected your
      // credentials" / "tracking has been failing" for this connection
      // untrue. Unverified saves leave them standing.
      if (input.isActive && rows[0]) {
        await markEntityNotificationsRead(tx, {
          tenantId: input.tenantId,
          entityType: 'courier_connection',
          entityIds: [rows[0].id],
          kinds: ['courier_connection_failing'],
          readAt: now,
        });
      }
      return rows;
    }, input.tenantId);

    // Deliberately logs the id and courier and nothing else — a credential
    // must never reach a log line, and neither must the account reference's
    // full value in a context where it routes webhooks.
    this.logger.log(
      `Courier connection upserted: ${row.id} (${input.courier}, active=${input.isActive}) for tenant ${input.tenantId}`,
      'CourierConnectionService',
    );
    return this.toConnection(row);
  }

  /** Tenant-scoped by argument AND by RLS — an id from another workspace resolves to null. */
  async findById(
    tenantId: string,
    id: string,
  ): Promise<CourierConnection | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(courierConnections)
          .where(
            and(
              eq(courierConnections.id, id),
              eq(courierConnections.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? this.toConnection(rows[0]) : null;
  }

  async findByTenant(tenantId: string): Promise<CourierConnection[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(courierConnections)
          .where(eq(courierConnections.tenantId, tenantId))
          .orderBy(
            desc(courierConnections.createdAt),
            asc(courierConnections.id),
          ),
      tenantId,
    );
    return (rows as CourierConnectionRow[]).map((row) =>
      this.toConnection(row),
    );
  }

  /** @returns false when nothing matched (unknown id, or another tenant's). */
  async deactivate(tenantId: string, id: string): Promise<boolean> {
    return this.setInactive(tenantId, id);
  }

  /** Rotates (or sets) the per-connection webhook secret. Returns the plaintext once — it is never readable again. */
  async rotateWebhookSecret(
    tenantId: string,
    id: string,
  ): Promise<string | null> {
    const secret = CourierConnectionService.generateWebhookSecret();
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(courierConnections)
          .set({
            webhookSecret: this.encryptSecret(secret),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(courierConnections.id, id),
              eq(courierConnections.tenantId, tenantId),
            ),
          )
          .returning({ id: courierConnections.id }),
      tenantId,
    );
    return rows.length > 0 ? secret : null;
  }

  async markPolled(tenantId: string, id: string): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(courierConnections)
          .set({ lastPolledAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(courierConnections.id, id),
              eq(courierConnections.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  /**
   * D8: the courier rejected our credentials. Polling this connection's
   * shipments must stop, and the merchant has to be told — a connection that
   * quietly goes stale is the failure mode F24's exit criteria banned.
   */
  async markCredentialsRejected(tenantId: string, id: string): Promise<void> {
    await this.setInactive(tenantId, id);
  }

  /** Deactivates the connection and drops its webhook route in one transaction. */
  private async setInactive(tenantId: string, id: string): Promise<boolean> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(courierConnections)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(courierConnections.id, id),
            eq(courierConnections.tenantId, tenantId),
          ),
        )
        .returning();
      if (rows[0]) await syncCourierRoute(tx, rows[0]);
      return rows.length > 0;
    }, tenantId);
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
        .from(courierConnections)
        .where(
          and(
            eq(courierConnections.tenantId, tenantId),
            eq(courierConnections.isActive, true),
          ),
        )
        .orderBy(asc(courierConnections.createdAt));
      // Oldest first, so for stores the newest connect ends up holding the
      // route, as it would have at connect time.
      for (const row of rows) await syncCourierRoute(tx, row);
      return rows.length;
    }, tenantId);
  }

  /** This tenant's active connections — what the poll sweep asks per tenant. */
  async findActiveByTenant(tenantId: string): Promise<CourierConnection[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(courierConnections)
          .where(
            and(
              eq(courierConnections.tenantId, tenantId),
              eq(courierConnections.isActive, true),
            ),
          )
          .orderBy(asc(courierConnections.id)),
      tenantId,
    );
    return (rows as CourierConnectionRow[]).map((row) =>
      this.toConnection(row),
    );
  }

  /**
   * PRE-TENANT read: a courier callback arrives with no tenant JWT — the
   * (courier, account_ref) pair IS the routing key (D6 step 2). The tenant
   * comes from `courier_routes` (not RLS-scoped, no secrets); the connection
   * and its secret are then read under that tenant, and must still be active
   * and still own the key. Reading `courier_connections` here directly would
   * return nothing under FORCE RLS (Clarly 2.0 fix).
   */
  async findByRoutingKey(
    courier: string,
    accountRef: string,
  ): Promise<CourierConnection | null> {
    const [route] = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          tenantId: courierRoutes.tenantId,
          connectionId: courierRoutes.connectionId,
        })
        .from(courierRoutes)
        .where(
          and(
            eq(courierRoutes.courier, courier),
            eq(courierRoutes.accountRef, accountRef),
          ),
        )
        .limit(1),
    );
    if (!route) return null;
    const connection = await this.findById(route.tenantId, route.connectionId);
    if (
      !connection ||
      !connection.isActive ||
      connection.courier !== courier ||
      connection.accountRef !== accountRef
    ) {
      return null;
    }
    return connection;
  }

  private encryptSecret(value: string): string {
    return this.encryption.encrypt({ [SECRET_FIELD]: value });
  }

  private decryptSecret(blob: string | null): string | null {
    if (!blob) return null;
    const decrypted = this.encryption.decrypt(blob)[SECRET_FIELD];
    return typeof decrypted === 'string' ? decrypted : null;
  }

  private toConnection(row: CourierConnectionRow): CourierConnection {
    const decrypted = this.encryption.decrypt(row.credentials);
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(decrypted)) {
      if (typeof value === 'string') credentials[key] = value;
    }

    return {
      id: row.id,
      tenantId: row.tenantId,
      courier: row.courier as CourierName,
      accountRef: row.accountRef,
      credentials,
      webhookSecret: this.decryptSecret(row.webhookSecret),
      isActive: row.isActive,
      lastVerifiedAt: row.lastVerifiedAt,
      lastPolledAt: row.lastPolledAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/**
 * Keeps `courier_routes` equal to the active connections, inside the caller's
 * tenant transaction (the routes table is not RLS-scoped, so the write works
 * there; nothing outside this service writes it).
 */
async function syncCourierRoute(
  tx: DrizzleDb,
  row: Pick<
    CourierConnectionRow,
    'id' | 'tenantId' | 'courier' | 'accountRef' | 'isActive'
  >,
): Promise<void> {
  if (!row.isActive) {
    await tx
      .delete(courierRoutes)
      .where(eq(courierRoutes.connectionId, row.id));
    return;
  }
  await tx
    .insert(courierRoutes)
    .values({
      courier: row.courier,
      accountRef: row.accountRef,
      tenantId: row.tenantId,
      connectionId: row.id,
    })
    .onConflictDoUpdate({
      target: [courierRoutes.courier, courierRoutes.accountRef],
      set: {
        tenantId: row.tenantId,
        connectionId: row.id,
        updatedAt: new Date(),
      },
    });
}
