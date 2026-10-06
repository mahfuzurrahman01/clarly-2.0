// F25 D1.3/D2/D6: the order write, and the reads the console does over it.
//
// This is the money path, so the discipline is stricter than elsewhere in the
// app and every deviation below is deliberate:
//
//  - The tenant's MODE is re-read inside the very transaction that writes the
//    row (D1.2 gate 2). The `tenant_tools` row that let the model see the tool
//    is a cache of an authorization decision, not the decision itself, and it
//    can be a second stale.
//  - Prices and product names are re-read from `products` INSIDE that same
//    transaction and snapshotted onto `order_items` (D2.2). Nothing the model
//    said about a price ever reaches a column.
//  - The insert is ONE statement — `ON CONFLICT DO NOTHING RETURNING` — never
//    a read-then-write. F20 shipped a two-transaction upsert race; this
//    feature touches money.
//  - The notification is written in the SAME transaction (D1.3 step 3), by
//    inserting the row directly rather than calling NotificationService: that
//    service opens its own `withTenantTx`, which on this pool is a SECOND
//    connection and therefore a second transaction — an order that committed
//    with no notification is an order nobody knows to approve.
import { Injectable } from '@nestjs/common';
import { ToolScopeViolation } from '@repo/errors';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  notifications,
  orderItems,
  orders,
  products,
  tenantOrderSettings,
  type OrderMode,
} from '../persistence/drizzle/schema';
import { DEFAULT_ORDER_MODE } from '../persistence/drizzle/tenant-order-settings.table';
import { uniqueViolationConstraint } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { AppLoggerService, Clock } from '../core';
import type { DrizzleDb } from '../persistence/persistence.providers';
import { deriveContentHash, deriveIdempotencyKey } from './order-idempotency';
import {
  initialStatusForMode,
  resolveOrderItems,
  type ResolvedOrderItems,
} from './order-item-resolution';
import { generateOrderReference } from './order-reference';
import { notificationContent } from '../notifications/notification-content';
import type {
  ListOrdersQuery,
  OrderItemView,
  OrderPage,
  OrderView,
} from './order.dto';

export interface CreateOrderCommand {
  tenantId: string;
  /** From the TURN CONTEXT, never from tool arguments (D2.2). */
  conversationId: string | null;
  customerId: string;
  turnId: string | null;
  contactName: string;
  contactPhone: string;
  address: string;
  city: string | null;
  notes: string | null;
  items: ReadonlyArray<{ productId: string; quantity: number }>;
  /** Pinned at creation time, resolved once by the caller (D4.4). */
  storeConnectionId: string | null;
  storeProvider: string | null;
}

export interface CreateOrderResult {
  order: OrderView;
  items: OrderItemView[];
  /** True when this call found an order a previous attempt had already written (D6.2 races 1-3). */
  duplicate: boolean;
}

/** How many times a reference collision is retried before giving up. ~1e9 keyspace; three is generous. */
const REFERENCE_RETRIES = 3;

@Injectable()
export class OrderService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Writes the order, or returns the one an earlier attempt already wrote.
   *
   * Throws `ToolScopeViolation` when the tenant's mode is `disabled` or
   * absent — the same error the registry gate raises, so it takes the existing
   * TOOL_SCOPE_VIOLATION escalation path in AgentRuntime and shows up in the
   * existing `tool_scope_violations` alerting. No parallel telemetry (D1.2).
   */
  async createFromTurn(
    command: CreateOrderCommand,
  ): Promise<CreateOrderResult> {
    const idempotencyKey = deriveIdempotencyKey({
      tenantId: command.tenantId,
      conversationId: command.conversationId,
      turnId: command.turnId,
      items: command.items,
      contactPhone: command.contactPhone,
    });
    const contentHash = deriveContentHash({
      tenantId: command.tenantId,
      conversationId: command.conversationId,
      items: command.items,
      contactPhone: command.contactPhone,
      contactName: command.contactName,
      address: command.address,
      city: command.city,
    });

    for (let attempt = 0; attempt < REFERENCE_RETRIES; attempt += 1) {
      try {
        const written = await this.attemptWrite(
          command,
          idempotencyKey,
          contentHash,
        );
        if (written) return written;

        // ON CONFLICT DO NOTHING matched the idempotency key: races #1 and #2.
        const existing = await this.findByIdempotencyKey(
          command.tenantId,
          idempotencyKey,
        );
        if (existing) return { ...existing, duplicate: true };

        // Vanishingly unlikely (the conflicting row was deleted between the
        // insert and this read); fall through and try again.
        continue;
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);

        // Race #3: a DIFFERENT turn in this conversation already has an
        // identical pending order. The partial unique index caught it.
        if (constraint === 'orders_pending_dedup_idx') {
          const existing = await this.findPendingByContentHash(
            command.tenantId,
            command.conversationId,
            contentHash,
          );
          if (existing) return { ...existing, duplicate: true };
          continue;
        }

        // A reference collision is the only violation worth retrying blind.
        if (constraint === 'orders_tenant_id_reference_unique') {
          this.logger.warn(
            `Order reference collision for tenant ${command.tenantId}; retrying (attempt ${attempt + 1})`,
            'OrderService',
          );
          continue;
        }

        throw error;
      }
    }

    throw new Error(
      `Could not write an order for tenant ${command.tenantId} after ${REFERENCE_RETRIES} attempts.`,
    );
  }

  /** One transaction: mode gate, item resolution, order + items + notification. Returns null when the idempotency key already existed. */
  private async attemptWrite(
    command: CreateOrderCommand,
    idempotencyKey: string,
    contentHash: string,
  ): Promise<CreateOrderResult | null> {
    return this.tenantContext.withTenantTx(async (tx) => {
      const mode = await this.readMode(tx, command.tenantId);

      // Gate 2 (D1.2). Defence in depth behind the registry gate.
      if (mode === 'disabled') {
        throw new ToolScopeViolation();
      }

      const resolved = await this.resolveItems(tx, command);
      const status = initialStatusForMode(mode);

      const inserted = await tx
        .insert(orders)
        .values({
          tenantId: command.tenantId,
          reference: generateOrderReference(),
          customerId: command.customerId,
          conversationId: command.conversationId,
          status,
          contactName: command.contactName,
          contactPhone: command.contactPhone,
          city: command.city,
          address: command.address,
          notes: command.notes,
          subtotal: resolved.subtotal,
          // Phase 1: no shipping cost and no VAT calculation (D3), so the
          // total IS the subtotal. A non-zero delta needs tenant tax config.
          total: resolved.subtotal,
          currency: resolved.currency,
          storeConnectionId: resolved.storePushable
            ? command.storeConnectionId
            : null,
          storeSyncStatus:
            resolved.storePushable && command.storeConnectionId
              ? status === 'confirmed'
                ? 'pending'
                : 'not_applicable'
              : 'not_applicable',
          idempotencyKey,
          contentHash,
        })
        .onConflictDoNothing({
          target: [orders.tenantId, orders.idempotencyKey],
        })
        .returning();

      const order = inserted[0];
      if (!order) return null;

      const items = await tx
        .insert(orderItems)
        .values(
          resolved.items.map((item) => ({
            tenantId: command.tenantId,
            orderId: order.id,
            productId: item.productId,
            productName: item.productName,
            sku: item.sku,
            unitPrice: item.unitPrice,
            currency: item.currency,
            quantity: item.quantity,
            lineTotal: item.lineTotal,
            externalProductId: item.externalProductId,
            externalVariantId: item.externalVariantId,
          })),
        )
        .returning();

      if (status === 'pending_approval') {
        await tx
          .insert(notifications)
          .values({
            tenantId: command.tenantId,
            ...notificationContent.orderPendingApproval({
              orderRef: order.reference,
              count: resolved.items.length,
              total: resolved.subtotal,
              currency: resolved.currency,
              customer: command.contactName,
            }),
            severity: 'warning',
            entityType: 'order',
            entityId: order.id,
            dedupKey: `order_pending_approval:${order.id}`,
          })
          .onConflictDoNothing({
            target: [notifications.tenantId, notifications.dedupKey],
          });
      }

      return {
        order: toOrderView(order),
        items: items.map(toItemView),
        duplicate: false,
      };
    }, command.tenantId);
  }

  /** Absence reads as `disabled` — fail closed (D1.1). */
  private async readMode(tx: DrizzleDb, tenantId: string): Promise<OrderMode> {
    const rows = await tx
      .select({ mode: tenantOrderSettings.mode })
      .from(tenantOrderSettings)
      .where(eq(tenantOrderSettings.tenantId, tenantId))
      .limit(1);
    return (rows[0]?.mode as OrderMode | undefined) ?? DEFAULT_ORDER_MODE;
  }

  /**
   * Reads the tenant's OWN catalogue rows inside the write transaction. RLS is
   * the isolation boundary: a product id belonging to another tenant simply
   * does not come back, and `resolveOrderItems` then reports it as unknown —
   * the same answer a genuinely nonexistent id gets, so nothing is learned by
   * probing.
   */
  private async resolveItems(
    tx: DrizzleDb,
    command: CreateOrderCommand,
  ): Promise<ResolvedOrderItems> {
    const ids = [...new Set(command.items.map((item) => item.productId))];
    const rows = await tx
      .select()
      .from(products)
      .where(
        and(eq(products.tenantId, command.tenantId), inArray(products.id, ids)),
      );

    return resolveOrderItems(command.items, rows, {
      storeProvider: command.storeProvider,
    });
  }

  private async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ order: OrderView; items: OrderItemView[] } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1),
      tenantId,
    );
    if (!rows[0]) return null;
    return this.withItems(tenantId, rows[0]);
  }

  private async findPendingByContentHash(
    tenantId: string,
    conversationId: string | null,
    contentHash: string,
  ): Promise<{ order: OrderView; items: OrderItemView[] } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              conversationId === null
                ? sql`${orders.conversationId} is null`
                : eq(orders.conversationId, conversationId),
              eq(orders.contentHash, contentHash),
              eq(orders.status, 'pending_approval'),
            ),
          )
          .limit(1),
      tenantId,
    );
    if (!rows[0]) return null;
    return this.withItems(tenantId, rows[0]);
  }

  // ---------------------------------------------------------------------
  // Console reads (D7)
  // ---------------------------------------------------------------------

  /** Keyset pagination on (created_at DESC, id DESC) — the order of the `orders_tenant_status_created_idx` index. */
  async list(tenantId: string, query: ListOrdersQuery): Promise<OrderPage> {
    const cursor = decodeCursor(query.cursor);

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, tenantId),
              query.status ? eq(orders.status, query.status) : undefined,
              query.storeSyncStatus
                ? eq(orders.storeSyncStatus, query.storeSyncStatus)
                : undefined,
              query.conversationId
                ? eq(orders.conversationId, query.conversationId)
                : undefined,
              query.customerId
                ? eq(orders.customerId, query.customerId)
                : undefined,
              cursor
                ? or(
                    lt(orders.createdAt, cursor.createdAt),
                    and(
                      eq(orders.createdAt, cursor.createdAt),
                      lt(orders.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(orders.createdAt), desc(orders.id))
          // One extra row answers "is there another page" without a count(*).
          .limit(query.limit + 1),
      tenantId,
    );

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
      orders: page.map(toOrderView),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  /** Null for a row this tenant cannot see — the controller turns that into 404, never 403 (F20's P1-3). */
  async get(
    tenantId: string,
    orderId: string,
  ): Promise<{ order: OrderView; items: OrderItemView[] } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(orders)
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
          .limit(1),
      tenantId,
    );
    if (!rows[0]) return null;
    return this.withItems(tenantId, rows[0]);
  }

  private async withItems(
    tenantId: string,
    order: typeof orders.$inferSelect,
  ): Promise<{ order: OrderView; items: OrderItemView[] }> {
    const items = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(orderItems)
          .where(
            and(
              eq(orderItems.tenantId, tenantId),
              eq(orderItems.orderId, order.id),
            ),
          ),
      tenantId,
    );
    return { order: toOrderView(order), items: items.map(toItemView) };
  }

  /** Exposed for the expiry sweep, which needs "now" from the same clock the rest of the module uses. */
  now(): Date {
    return this.clock.now();
  }
}

export function toOrderView(row: typeof orders.$inferSelect): OrderView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    reference: row.reference,
    customerId: row.customerId,
    conversationId: row.conversationId,
    status: row.status,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    city: row.city,
    address: row.address,
    notes: row.notes,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    subtotal: row.subtotal,
    total: row.total,
    currency: row.currency,
    storeConnectionId: row.storeConnectionId,
    storeSyncStatus: row.storeSyncStatus,
    externalOrderId: row.externalOrderId,
    storeSyncAttempts: row.storeSyncAttempts,
    storeSyncError: row.storeSyncError,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    rejectedReason: row.rejectedReason,
    customerNotifiedAt: row.customerNotifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toItemView(row: typeof orderItems.$inferSelect): OrderItemView {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.productName,
    sku: row.sku,
    unitPrice: row.unitPrice,
    currency: row.currency,
    quantity: row.quantity,
    lineTotal: row.lineTotal,
    externalProductId: row.externalProductId,
    externalVariantId: row.externalVariantId,
  };
}

/** Opaque to the caller on purpose: the console must not build one by hand and pin itself to the sort key. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    const createdAt = new Date(iso ?? '');
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    // A malformed cursor reads as "start from the beginning" rather than 500ing
    // — it is client-supplied text, and there is nothing a caller can do with
    // an error about the encoding of a token we told them was opaque.
    return null;
  }
}
