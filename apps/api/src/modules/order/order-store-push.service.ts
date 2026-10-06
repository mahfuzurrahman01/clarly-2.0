// F25 D4: pushing a confirmed order to the tenant's connected store.
//
// This is the piece that replaces F24's synchronous, in-loop provider call.
// The old shape called `StoreProvider.createOrder()` inside the agent's
// bounded loop and returned the provider's result straight to the model, so a
// Salla timeout burned the agent's loop deadline (T9's latency budget) AND
// lost the order entirely — nothing had been persisted on our side. Here the
// order is already committed before this class is ever reached.
//
// The ORDER'S STATUS IS NEVER TOUCHED BY THIS CLASS. A store outage moves
// `store_sync_status`, `store_sync_attempts` and `store_sync_error`; the
// customer's order is real whether or not Salla accepted it (D4.6).
//
// At-most-once, three overlapping defences (D6.2 race #5):
//   1. BullMQ `jobId = order id`, so a second enqueue is a no-op;
//   2. `SELECT ... FOR UPDATE` on the order row inside this transaction, so a
//      second worker that got past (1) blocks and then reads `synced`;
//   3. `UNIQUE (tenant_id, store_connection_id, external_order_id)`, so even a
//      double push cannot record two external ids.
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { orderItems, orders } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { AppLoggerService } from '../core';
import { NotificationService } from '../notifications/notification.service';
import { notificationContent } from '../notifications/notification-content';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';
import { StoreConnectionService } from '../store/store-connection.service';
import { StoreOAuthService } from '../store/store-oauth.service';
import { StoreProviderRegistry } from '../store/store-provider.registry';
import { ORDER_STORE_PUSH_ATTEMPTS } from './order-store-push.queue';

export type OrderStorePushOutcome =
  | 'synced'
  | 'already_synced'
  | 'not_applicable'
  | 'retryable_failure'
  | 'exhausted';

@Injectable()
export class OrderStorePushService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly connections: StoreConnectionService,
    private readonly oauth: StoreOAuthService,
    private readonly registry: StoreProviderRegistry,
    private readonly notifications: NotificationService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Runs one push attempt. Returns an outcome rather than throwing for the
   * expected branches, and throws only when BullMQ should retry — the queue's
   * backoff is the retry mechanism, not a loop in here.
   */
  async push(
    tenantId: string,
    orderId: string,
  ): Promise<OrderStorePushOutcome> {
    const prepared = await this.tenantContext.withTenantTx(async (tx) => {
      // FOR UPDATE: the belt to BullMQ's braces (D4.5).
      const rows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
        .for('update')
        .limit(1);

      const order = rows[0];
      if (!order) return { outcome: 'not_applicable' as const };
      if (order.storeSyncStatus === 'synced') {
        return { outcome: 'already_synced' as const };
      }
      // An order that never had a pinned connection, or that is no longer
      // confirmed (cancelled while the job sat in the queue), has nothing to
      // push. A tenant with a CSV catalogue and no store is a first-class,
      // fully supported outcome (D4.3).
      if (!order.storeConnectionId || order.status !== 'confirmed') {
        return { outcome: 'not_applicable' as const };
      }

      const items = await tx
        .select()
        .from(orderItems)
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            eq(orderItems.orderId, orderId),
          ),
        );

      return { outcome: 'proceed' as const, order, items };
    }, tenantId);

    if (prepared.outcome !== 'proceed') return prepared.outcome;

    const { order, items } = prepared;
    const connection = await this.connections.findById(
      tenantId,
      order.storeConnectionId as string,
    );

    if (!connection || !connection.isActive) {
      await this.recordFailure(
        tenantId,
        orderId,
        'The store connection this order was pinned to is gone or inactive.',
      );
      return 'exhausted';
    }

    try {
      const { accessToken, authorizationToken } =
        await this.oauth.ensureCredentials(connection);
      const result = await this.registry
        .forProvider(connection.provider)
        .createOrder(
          accessToken,
          {
            customerName: order.contactName,
            customerPhone: order.contactPhone,
            shippingAddress: order.address,
            items: items.map((item) => ({
              // The external ids were resolved and snapshotted AT ORDER TIME, so
              // a catalogue re-sync since then cannot repoint this order.
              productId: item.externalProductId as string,
              variantId: item.externalVariantId ?? undefined,
              quantity: item.quantity,
              price: Number(item.unitPrice),
            })),
            notes: order.notes ?? undefined,
          },
          { shop: connection.storeId, authorizationToken },
        );

      // D4.7: `external_order_id` and `synced` in ONE conditional statement,
      // guarded on the row not already being synced.
      await this.tenantContext.withTenantTx(async (tx) => {
        const now = new Date();
        const synced = await tx
          .update(orders)
          .set({
            storeSyncStatus: 'synced',
            externalOrderId: result.orderId,
            // Persisted, never sent to the customer (D3): with no payment
            // webhook we could not answer their next question.
            storePaymentUrl: result.paymentUrl ?? null,
            storeSyncError: null,
            storeSyncAttempts: sql`${orders.storeSyncAttempts} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.id, orderId),
              sql`${orders.storeSyncStatus} <> 'synced'`,
            ),
          )
          .returning({ id: orders.id });
        // QA 2026-10-05: a retry that got through makes "could not be sent
        // to your store" false; retired with the write that proves it.
        if (synced.length > 0) {
          await markEntityNotificationsRead(tx, {
            tenantId,
            entityType: 'order',
            entityIds: [orderId],
            kinds: ['order_store_push_failed'],
            readAt: now,
          });
        }
      }, tenantId);

      this.logger.log(
        `Order ${order.reference} synced to ${connection.provider} as ${result.orderId}`,
        'OrderStorePushService',
      );
      return 'synced';
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown store error';
      const attempts = await this.recordAttempt(tenantId, orderId, message);

      if (attempts >= ORDER_STORE_PUSH_ATTEMPTS) {
        await this.recordFailure(tenantId, orderId, message);
        return 'exhausted';
      }

      this.logger.warn(
        `Order ${order.reference} store push attempt ${attempts} failed: ${message}`,
        'OrderStorePushService',
      );
      return 'retryable_failure';
    }
  }

  /** Increments the attempt counter and records the last error, returning the new count. */
  private async recordAttempt(
    tenantId: string,
    orderId: string,
    message: string,
  ): Promise<number> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(orders)
          .set({
            storeSyncAttempts: sql`${orders.storeSyncAttempts} + 1`,
            storeSyncError: message.slice(0, 1_000),
            updatedAt: new Date(),
          })
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
          .returning({ attempts: orders.storeSyncAttempts }),
      tenantId,
    );
    return rows[0]?.attempts ?? ORDER_STORE_PUSH_ATTEMPTS;
  }

  /** Terminal for the SYNC, not for the order: `status` is untouched (D4.6). */
  private async recordFailure(
    tenantId: string,
    orderId: string,
    message: string,
  ): Promise<void> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(orders)
          .set({
            storeSyncStatus: 'failed',
            storeSyncError: message.slice(0, 1_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.id, orderId),
              sql`${orders.storeSyncStatus} <> 'synced'`,
            ),
          )
          .returning({ reference: orders.reference }),
      tenantId,
    );

    const reference = rows[0]?.reference;
    if (!reference) return;

    await this.notifications.record({
      tenantId,
      ...notificationContent.orderStorePushFailed({
        orderRef: reference,
        error: message,
      }),
      severity: 'critical',
      entityType: 'order',
      entityId: orderId,
      dedupKey: `order_store_push_failed:${orderId}`,
    });
  }
}
