// F25 D1.4: approve / reject / cancel / expire.
//
// Every transition is a SINGLE CONDITIONAL UPDATE guarded on the current
// status — never read-then-write. Two console users clicking Approve at the
// same moment is the ordinary case, not the edge case, and the same discipline
// `CustomerLabelService.applyAgentSignal()` uses for the same reason. Zero rows
// back means somebody else got there first, and the caller is told 409 (D6.2
// race #4).
//
// Telling the customer is a SIDE EFFECT of a committed decision, never part of
// it: the send goes through the existing `HumanReplyService` — the path a
// human agent's reply already takes, not a second sender — and a failure
// (closed WhatsApp service window) leaves `customer_notified_at` NULL without
// rolling the approval back. The console shows "customer not notified".
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { orderItems, orders, products } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { AppLoggerService, Clock } from '../core';
import { HumanReplyService } from '../inbox/human-reply.service';
import {
  ORDER_STORE_PUSH_ATTEMPTS,
  ORDER_STORE_PUSH_JOB_NAME,
  ORDER_STORE_PUSH_QUEUE,
  orderStorePushJobId,
  type OrderStorePushJobData,
} from './order-store-push.queue';
import {
  canTransition,
  InvalidOrderTransitionError,
} from './order-status-transition';
import type { OrderStatus } from '../persistence/drizzle/orders.table';
import { toOrderView } from './order.service';
import type { OrderView } from './order.dto';
import { describeStockShortfall, isOrderable } from './order-item-resolution';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';
import type { DrizzleDb } from '../persistence/persistence.providers';

/** The notification a pending order raises, which any decision on the order settles. */
const APPROVAL_PROMPT_KINDS = ['order_pending_approval'] as const;

@Injectable()
export class OrderApprovalService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly humanReply: HumanReplyService,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
    @InjectQueue(ORDER_STORE_PUSH_QUEUE)
    private readonly storePushQueue: Queue<OrderStorePushJobData>,
  ) {}

  /**
   * `pending_approval` -> `confirmed`, re-validating stock on the way (D2.4:
   * stock is validated at create time AND at approve time, because phase 1
   * reserves nothing). An item that has gone out of stock since is a 409 with
   * the item named, and the human decides.
   */
  async approve(
    tenantId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<OrderView> {
    const order = await this.requireOrder(tenantId, orderId);
    this.assertTransition(order.status as OrderStatus, 'confirmed');

    const shortfall = await this.findStockShortfall(tenantId, orderId);
    if (shortfall) {
      throw new ConflictException(
        `${describeStockShortfall(shortfall.productName, shortfall.available)} (this order needs ${shortfall.required}).`,
      );
    }

    const now = this.clock.now();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(orders)
        .set({
          status: 'confirmed',
          approvedBy: actorUserId,
          approvedAt: now,
          // Only an order with a pinned connection has anywhere to go.
          storeSyncStatus: sql`case when ${orders.storeConnectionId} is null then ${orders.storeSyncStatus} else 'pending' end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.id, orderId),
            eq(orders.status, 'pending_approval'),
          ),
        )
        .returning();
      await this.retireApprovalPrompts(tx, tenantId, rows, now);
      return rows;
    }, tenantId);

    if (!row) {
      throw new ConflictException(
        'This order is no longer awaiting approval — somebody else has already decided it.',
      );
    }

    await this.enqueueStorePush(tenantId, row);
    const notified = await this.notifyCustomer(
      tenantId,
      row,
      `Your order ${row.reference} is confirmed. Total ${row.total} ${row.currency}, cash on delivery. We will be in touch about delivery.`,
      actorUserId,
    );

    return toOrderView(notified ?? row);
  }

  async reject(
    tenantId: string,
    orderId: string,
    actorUserId: string,
    reason: string,
  ): Promise<OrderView> {
    const order = await this.requireOrder(tenantId, orderId);
    this.assertTransition(order.status as OrderStatus, 'rejected');

    const now = this.clock.now();
    const [row] = await this.tenantContext.withTenantTx(async (tx) => {
      const rows = await tx
        .update(orders)
        .set({
          status: 'rejected',
          rejectedReason: reason,
          approvedBy: actorUserId,
          approvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.id, orderId),
            eq(orders.status, 'pending_approval'),
          ),
        )
        .returning();
      await this.retireApprovalPrompts(tx, tenantId, rows, now);
      return rows;
    }, tenantId);

    if (!row) {
      throw new ConflictException(
        'This order is no longer awaiting approval — somebody else has already decided it.',
      );
    }

    // The REASON is for the merchant's records, not for the customer: it is
    // free text a colleague typed for internal use and may say things
    // ("suspected fraud", "repeat no-show") that must not be sent to anyone.
    const notified = await this.notifyCustomer(
      tenantId,
      row,
      `We are sorry — we are not able to fulfil order ${row.reference}. Our team will follow up with you here.`,
      actorUserId,
    );

    return toOrderView(notified ?? row);
  }

  /** `confirmed` -> `cancelled`. The console shows cancel only; refunds and order editing are deferred (D3). */
  async cancel(
    tenantId: string,
    orderId: string,
    actorUserId: string,
  ): Promise<OrderView> {
    const order = await this.requireOrder(tenantId, orderId);
    this.assertTransition(order.status as OrderStatus, 'cancelled');

    const now = this.clock.now();
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(orders)
          .set({ status: 'cancelled', updatedAt: now })
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.id, orderId),
              eq(orders.status, 'confirmed'),
            ),
          )
          .returning(),
      tenantId,
    );

    if (!row) {
      throw new ConflictException(
        'This order is no longer confirmed — its state changed before the cancellation was applied.',
      );
    }

    const notified = await this.notifyCustomer(
      tenantId,
      row,
      `Order ${row.reference} has been cancelled. Our team will follow up with you here.`,
      actorUserId,
    );
    return toOrderView(notified ?? row);
  }

  /** D4.6: re-enqueue a push that exhausted its attempts. Only from `failed`. */
  async retryStorePush(tenantId: string, orderId: string): Promise<OrderView> {
    const order = await this.requireOrder(tenantId, orderId);
    if (order.storeSyncStatus !== 'failed') {
      throw new ConflictException(
        `This order's store sync is "${order.storeSyncStatus}", not "failed" — there is nothing to retry.`,
      );
    }

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(orders)
          .set({
            storeSyncStatus: 'pending',
            storeSyncAttempts: 0,
            storeSyncError: null,
            updatedAt: this.clock.now(),
          })
          .where(
            and(
              eq(orders.tenantId, tenantId),
              eq(orders.id, orderId),
              eq(orders.storeSyncStatus, 'failed'),
            ),
          )
          .returning(),
      tenantId,
    );

    if (!row) {
      throw new ConflictException(
        'This order is no longer in a failed sync state.',
      );
    }

    await this.enqueueStorePush(tenantId, row, { force: true });
    return toOrderView(row);
  }

  /**
   * D1.4's sweep, for one tenant. `pending_approval` orders older than the
   * tenant's own `approval_window_hours` become `expired` in one statement.
   */
  async expireOverdue(
    tenantId: string,
    approvalWindowHours: number,
  ): Promise<number> {
    const cutoff = new Date(
      this.clock.nowMs() - approvalWindowHours * 60 * 60 * 1000,
    );

    const now = this.clock.now();
    const rows = await this.tenantContext.withTenantTx(async (tx) => {
      const expired = await tx
        .update(orders)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.status, 'pending_approval'),
            lt(orders.createdAt, cutoff),
          ),
        )
        .returning({ id: orders.id });
      // An expired order can no longer be approved, so "waiting for approval"
      // is now false. The order list still shows it as expired.
      await this.retireApprovalPrompts(tx, tenantId, expired, now);
      return expired;
    }, tenantId);

    if (rows.length > 0) {
      this.logger.log(
        `Expired ${rows.length} pending order(s) for tenant ${tenantId} past a ${approvalWindowHours}h approval window`,
        'OrderApprovalService',
      );
    }
    return rows.length;
  }

  // ---------------------------------------------------------------------

  /**
   * QA 2026-10-05 (ISSUE-012): once an order is decided or expired, its
   * "waiting for approval" notification is stale. Retired in the SAME
   * transaction as the status change, and only for rows that change actually
   * moved: a losing racer (zero rows, 409) retires nothing.
   */
  private async retireApprovalPrompts(
    tx: DrizzleDb,
    tenantId: string,
    decided: ReadonlyArray<{ id: string }>,
    readAt: Date,
  ): Promise<void> {
    if (decided.length === 0) return;
    await markEntityNotificationsRead(tx, {
      tenantId,
      entityType: 'order',
      entityIds: decided.map((order) => order.id),
      kinds: APPROVAL_PROMPT_KINDS,
      readAt,
    });
  }

  private async requireOrder(
    tenantId: string,
    orderId: string,
  ): Promise<typeof orders.$inferSelect> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(orders)
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
          .limit(1),
      tenantId,
    );
    // Another tenant's id is indistinguishable from a nonexistent one, because
    // RLS means we genuinely cannot see it. 404, never 403 (F20's P1-3).
    if (!rows[0]) throw new NotFoundException(`Order ${orderId} not found`);
    return rows[0];
  }

  /**
   * The pre-flight check. The conditional UPDATE is still the authority — this
   * exists so a caller gets "you cannot cancel a rejected order" (409, with
   * the reason) rather than the generic race message.
   */
  private assertTransition(from: OrderStatus, to: OrderStatus): void {
    if (!canTransition(from, to)) {
      throw new InvalidOrderTransitionError(from, to);
    }
  }

  private async findStockShortfall(
    tenantId: string,
    orderId: string,
  ): Promise<{
    productName: string;
    required: number;
    available: number | null;
  } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            productName: orderItems.productName,
            required: orderItems.quantity,
            available: products.stock,
            stockStatus: products.stockStatus,
            isActive: products.isActive,
          })
          .from(orderItems)
          .innerJoin(
            products,
            and(
              eq(orderItems.productId, products.id),
              eq(products.tenantId, tenantId),
            ),
          )
          .where(
            and(
              eq(orderItems.tenantId, tenantId),
              eq(orderItems.orderId, orderId),
            ),
          ),
      tenantId,
    );

    // A product deleted since the order was placed leaves `product_id` NULL and
    // drops out of the join. That is NOT a shortfall: the line's price and name
    // are snapshotted on the item, and the merchant is the one approving.
    for (const row of rows) {
      const orderable = isOrderable(
        { stock: row.available, stockStatus: row.stockStatus },
        row.required,
      );
      if (!row.isActive || !orderable) {
        return {
          productName: row.productName,
          required: row.required,
          available: row.isActive ? row.available : 0,
        };
      }
    }
    return null;
  }

  private async enqueueStorePush(
    tenantId: string,
    order: typeof orders.$inferSelect,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!order.storeConnectionId) return;
    if (!options.force && order.storeSyncStatus === 'synced') return;

    try {
      await this.storePushQueue.add(
        ORDER_STORE_PUSH_JOB_NAME,
        { tenantId, orderId: order.id },
        {
          // The queue itself dedupes on this (D6.2 race #5).
          jobId: orderStorePushJobId(order.id),
          attempts: ORDER_STORE_PUSH_ATTEMPTS,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      // A Redis blip must not roll back a committed approval. The order is
      // `confirmed` with `store_sync_status='pending'`, which is exactly what
      // `POST /orders/:id/retry-store-push` is for.
      this.logger.error(
        `Could not enqueue the store push for order ${order.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        'OrderApprovalService',
      );
    }
  }

  /**
   * One outbound message through the path a human agent's reply already takes.
   * Returns the updated row when the customer was reached, or null when they
   * were not — in which case `customer_notified_at` stays NULL and the console
   * shows "customer not notified". Templated out-of-window confirmations are
   * F26's (D1.4); F25 does not build a second template path.
   */
  private async notifyCustomer(
    tenantId: string,
    order: typeof orders.$inferSelect,
    text: string,
    actorUserId: string,
  ): Promise<typeof orders.$inferSelect | null> {
    if (!order.conversationId) return null;

    try {
      const result = await this.humanReply.reply({
        tenantId,
        conversationId: order.conversationId,
        userId: actorUserId,
        text,
        // Deterministic: a double-click on Approve must not send twice, and
        // HumanReplyService dedupes on exactly this.
        clientMessageId: `order-status:${order.id}:${order.status}`,
      });

      if (!result.delivered) return null;

      const [row] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(orders)
            .set({ customerNotifiedAt: this.clock.now() })
            .where(and(eq(orders.tenantId, tenantId), eq(orders.id, order.id)))
            .returning(),
        tenantId,
      );
      return row ?? null;
    } catch (error) {
      // WA_WINDOW_CLOSED and every other send failure land here. The decision
      // is committed; only the telling failed.
      this.logger.warn(
        `Order ${order.reference} status was not delivered to the customer: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'OrderApprovalService',
      );
      return null;
    }
  }
}
