// F26 (Delivery Tracking): shipments and their status history.
//
// `applyStatusEvents()` is the ONE place that decides "the status changed",
// and therefore the one place that decides "notify" (D5). Both the poll sweep
// and the J&T webhook converge here; nothing else writes
// `shipment_status_events` or `shipments.current_status`.
//
// Three rules live in this file and nowhere else:
//   - Dedup: polling re-reads the courier's WHOLE event list every sweep, so
//     inserts go through the (shipment_id, raw_status, occurred_at) unique key
//     with onConflictDoNothing. Re-polling an unchanged parcel writes nothing.
//   - Forward-only for NOTIFICATION purposes: couriers replay old events, and
//     a `delivered -> in_transit` regression is recorded in history but is
//     never a reason to message a customer.
//   - Terminal statuses stop polling — enforced by the partial index, which
//     is why the poll selector filters on `current_status` with the exact
//     same predicate rather than with a hand-maintained code list.
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  orders,
  shipments,
  shipmentStatusEvents,
  type ShipmentEventSource,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { AppLoggerService } from '../core';
import {
  isForwardTransition,
  isTerminalStatus,
  type CourierName,
  type CourierStatusEvent,
  type ShipmentStatus,
} from './ports/courier-connector.port';

export interface ShipmentRecord {
  id: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  courierConnectionId: string;
  courier: CourierName;
  trackingNumber: string;
  currentStatus: ShipmentStatus;
  currentStatusAt: Date | null;
  estimatedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  lastNotifiedStatus: string | null;
  lastNotifiedAt: Date | null;
  lastPolledAt: Date | null;
  pollFailureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateShipmentInput {
  tenantId: string;
  orderId: string;
  customerId: string;
  courierConnectionId: string;
  courier: CourierName;
  trackingNumber: string;
}

export interface ShipmentStatusEventRecord {
  id: string;
  shipmentId: string;
  status: ShipmentStatus;
  rawStatus: string;
  location: string | null;
  occurredAt: Date;
  source: ShipmentEventSource;
}

/**
 * The outcome of applying a courier's event list to one shipment. The
 * notification decision is NOT taken here — this returns what happened and
 * `DeliveryNotificationService` decides whether a customer hears about it, so
 * that "status changed" and "tell someone" stay separable and separately
 * testable.
 */
export interface ApplyStatusOutcome {
  shipmentId: string;
  newEventCount: number;
  previousStatus: ShipmentStatus;
  currentStatus: ShipmentStatus;
  /** True only for a status that both changed AND moved forward — the D5 notification trigger. */
  notifiableTransition: boolean;
}

/**
 * Per-status poll cadence (D5). `out_for_delivery` is the status a customer
 * asks about, so it is refreshed fastest; `label_created` barely moves.
 */
export const POLL_CADENCE_MS: Readonly<Record<string, number>> = {
  out_for_delivery: 10 * 60 * 1000,
  in_transit: 30 * 60 * 1000,
  exception: 30 * 60 * 1000,
  failed_attempt: 30 * 60 * 1000,
  label_created: 2 * 60 * 60 * 1000,
  picked_up: 2 * 60 * 60 * 1000,
  unknown: 2 * 60 * 60 * 1000,
};

export const DEFAULT_POLL_CADENCE_MS = 30 * 60 * 1000;

/** D8: after this many consecutive poll failures the connection is flagged and the merchant told, rather than going quietly stale. */
export const POLL_FAILURE_ALERT_THRESHOLD = 10;

/** A customer has a handful of open parcels, not a hundred; a bounded read keeps one answer's cost bounded. */
export const TRACK_ORDER_RESULT_LIMIT = 10;

const NON_TERMINAL_PREDICATE = notInArray(shipments.currentStatus, [
  'delivered',
  'returned',
  'cancelled',
]);

@Injectable()
export class ShipmentService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly logger: AppLoggerService,
  ) {}

  async create(input: CreateShipmentInput): Promise<ShipmentRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(shipments)
          .values({
            tenantId: input.tenantId,
            orderId: input.orderId,
            // Denormalized from the order at creation: this column IS the
            // track_order authorization predicate (D4).
            customerId: input.customerId,
            courierConnectionId: input.courierConnectionId,
            courier: input.courier,
            trackingNumber: input.trackingNumber,
          })
          .onConflictDoUpdate({
            target: [
              shipments.tenantId,
              shipments.courier,
              shipments.trackingNumber,
            ],
            set: { updatedAt: new Date() },
          })
          .returning(),
      input.tenantId,
    );
    return toRecord(row);
  }

  async findById(tenantId: string, id: string): Promise<ShipmentRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipments)
          .where(and(eq(shipments.id, id), eq(shipments.tenantId, tenantId)))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The console's order view. Tenant-scoped only — this is a staff surface, not the customer-scoped tool path. */
  async findByOrder(
    tenantId: string,
    orderId: string,
  ): Promise<ShipmentRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.tenantId, tenantId),
              eq(shipments.orderId, orderId),
            ),
          )
          .orderBy(desc(shipments.createdAt), asc(shipments.id)),
      tenantId,
    );
    return rows.map(toRecord);
  }

  /**
   * The `track_order` read (D4). The predicate is ALWAYS
   * `tenant_id AND customer_id`, both from execution context and never from a
   * tool argument, inside `withTenantTx` so RLS is the second of two
   * independent barriers.
   */
  async findForCustomer(
    tenantId: string,
    customerId: string,
    filter: { orderId?: string; trackingNumber?: string } = {},
  ): Promise<ShipmentRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.tenantId, tenantId),
              eq(shipments.customerId, customerId),
              filter.orderId
                ? eq(shipments.orderId, filter.orderId)
                : undefined,
              filter.trackingNumber
                ? eq(shipments.trackingNumber, filter.trackingNumber)
                : undefined,
            ),
          )
          .orderBy(desc(shipments.createdAt), asc(shipments.id))
          .limit(10),
      tenantId,
    );
    return rows.map(toRecord);
  }

  /**
   * The `track_order` read (D4), joined to the order so the answer can quote
   * the reference the customer actually used.
   *
   * `orders` is F25's table and F26 only READS it — the same one-way
   * relationship `shipments.order_id`'s foreign key already declares. A
   * module dependency on OrderModule would buy nothing here: this is one
   * column, inside the same tenant transaction, and the FK means the row is
   * guaranteed to exist.
   *
   * The predicate is ALWAYS `tenant_id AND customer_id`, both from execution
   * context and never from a tool argument, inside `withTenantTx` so RLS is
   * the second of two independent barriers. `orderReference` and
   * `trackingNumber` NARROW that set; they can never widen it.
   */
  async findForCustomerWithReference(
    tenantId: string,
    customerId: string,
    filter: { orderReference?: string; trackingNumber?: string } = {},
  ): Promise<Array<ShipmentRecord & { orderReference: string }>> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ shipment: shipments, orderReference: orders.reference })
          .from(shipments)
          .innerJoin(orders, eq(orders.id, shipments.orderId))
          .where(
            and(
              eq(shipments.tenantId, tenantId),
              eq(shipments.customerId, customerId),
              filter.orderReference
                ? eq(orders.reference, filter.orderReference)
                : undefined,
              filter.trackingNumber
                ? eq(shipments.trackingNumber, filter.trackingNumber)
                : undefined,
            ),
          )
          .orderBy(desc(shipments.createdAt), asc(shipments.id))
          .limit(TRACK_ORDER_RESULT_LIMIT),
      tenantId,
    );
    return rows.map((row) => ({
      ...toRecord(row.shipment),
      orderReference: row.orderReference,
    }));
  }

  /**
   * The webhook's shipment lookup (D6 step 5). The tenant comes from the
   * resolved CONNECTION, never from the callback body; this only turns the
   * courier's own waybill number into our row inside that tenant.
   */
  async findByTrackingNumber(
    tenantId: string,
    courier: CourierName,
    trackingNumber: string,
  ): Promise<ShipmentRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.tenantId, tenantId),
              eq(shipments.courier, courier),
              eq(shipments.trackingNumber, trackingNumber),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async history(
    tenantId: string,
    shipmentId: string,
  ): Promise<ShipmentStatusEventRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipmentStatusEvents)
          .where(
            and(
              eq(shipmentStatusEvents.tenantId, tenantId),
              eq(shipmentStatusEvents.shipmentId, shipmentId),
            ),
          )
          .orderBy(desc(shipmentStatusEvents.occurredAt)),
      tenantId,
    );
    return rows.map((row) => ({
      id: row.id,
      shipmentId: row.shipmentId,
      status: row.status as ShipmentStatus,
      rawStatus: row.rawStatus,
      location: row.location,
      occurredAt: row.occurredAt,
      source: row.source as ShipmentEventSource,
    }));
  }

  /** The latest recorded event for a shipment — what `track_order` reads for `lastLocation`. */
  async latestEvent(
    tenantId: string,
    shipmentId: string,
  ): Promise<ShipmentStatusEventRecord | null> {
    const rows = await this.history(tenantId, shipmentId);
    return rows[0] ?? null;
  }

  /**
   * The single convergence point for poll and webhook (D5).
   *
   * Everything happens in ONE transaction: the history insert, the status
   * update and the read-back that decides `notifiableTransition`. A separate
   * read would let two concurrent callers each see the old status and each
   * conclude they were the one who moved it — the notification claim row is
   * the hard guard against a double send, but there is no reason to hand it
   * two winners to arbitrate.
   */
  async applyStatusEvents(
    tenantId: string,
    shipmentId: string,
    events: CourierStatusEvent[],
    source: ShipmentEventSource,
    estimatedDeliveryAt?: Date,
  ): Promise<ApplyStatusOutcome | null> {
    if (events.length === 0) {
      return null;
    }

    return this.tenantContext.withTenantTx(async (tx) => {
      const [existing] = await tx
        .select()
        .from(shipments)
        .where(
          and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)),
        )
        .limit(1);
      if (!existing) return null;

      const previousStatus = existing.currentStatus as ShipmentStatus;

      const inserted = await tx
        .insert(shipmentStatusEvents)
        .values(
          events.map((event) => ({
            tenantId,
            shipmentId,
            status: event.status,
            rawStatus: event.rawStatus,
            location: event.location ?? null,
            occurredAt: event.occurredAt,
            source,
          })),
        )
        // The dedup that makes re-polling free. Without it the history would
        // grow by the courier's whole event list on every sweep.
        .onConflictDoNothing({
          target: [
            shipmentStatusEvents.shipmentId,
            shipmentStatusEvents.rawStatus,
            shipmentStatusEvents.occurredAt,
          ],
        })
        .returning({ id: shipmentStatusEvents.id });

      // The latest event by occurrence time, not by arrival order: couriers
      // deliver scans out of order, and the newest SCAN is what the parcel's
      // status is — whichever order they reached us in.
      const latest = [...events].sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
      )[events.length - 1];

      const moved =
        latest.status !== previousStatus &&
        isForwardTransition(previousStatus, latest.status);

      if (moved) {
        await tx
          .update(shipments)
          .set({
            currentStatus: latest.status,
            currentStatusAt: latest.occurredAt,
            deliveredAt:
              latest.status === 'delivered'
                ? latest.occurredAt
                : existing.deliveredAt,
            ...(estimatedDeliveryAt ? { estimatedDeliveryAt } : {}),
            lastPolledAt: new Date(),
            pollFailureCount: 0,
            updatedAt: new Date(),
          })
          .where(
            and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)),
          );
      } else {
        // A regression or a repeat is still a successful read: it refreshes
        // `last_polled_at` (so the sweep backs off) and clears the failure
        // count, but it never rewrites the status backwards.
        await tx
          .update(shipments)
          .set({
            lastPolledAt: new Date(),
            pollFailureCount: 0,
            ...(estimatedDeliveryAt ? { estimatedDeliveryAt } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)),
          );

        if (latest.status !== previousStatus) {
          this.logger.debug(
            `Shipment ${shipmentId}: ignoring backwards transition ${previousStatus} -> ${latest.status} for notification purposes (recorded in history)`,
            'ShipmentService',
          );
        }
      }

      return {
        shipmentId,
        newEventCount: inserted.length,
        previousStatus,
        currentStatus: moved ? latest.status : previousStatus,
        notifiableTransition: moved,
      };
    }, tenantId);
  }

  /** D5 backoff: a failed poll increments the counter; the next success resets it. */
  async recordPollFailure(
    tenantId: string,
    shipmentIds: string[],
  ): Promise<void> {
    if (shipmentIds.length === 0) return;
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(shipments)
          .set({
            pollFailureCount: sql`${shipments.pollFailureCount} + 1`,
            lastPolledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(shipments.tenantId, tenantId),
              inArray(shipments.id, shipmentIds),
            ),
          ),
      tenantId,
    );
  }

  /** Console/ops read convenience, written after a successful send. NOT the dedup authority — `shipment_notifications` is (D5). */
  async markNotified(
    tenantId: string,
    shipmentId: string,
    status: ShipmentStatus,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(shipments)
          .set({
            lastNotifiedStatus: status,
            lastNotifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)),
          ),
      tenantId,
    );
  }

  /**
   * One tenant's shipments that are due a poll: non-terminal, and whose
   * per-status cadence has elapsed. Read under `withTenantTx(tenantId)` — the
   * sweep enters each tenant in turn (TenantDirectoryService); a platform-wide
   * read of this FORCE-RLS table would return nothing.
   *
   * The predicate matches `shipments_poll_idx`, and the cadence is applied in
   * SQL rather than in a filter after the fact, so a merchant with many
   * parcels in flight never loads them all to throw most away.
   */
  async findDueForPoll(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<ShipmentRecord[]> {
    const cadenceCase = sql`(case
      when ${shipments.currentStatus} = 'out_for_delivery' then interval '10 minutes'
      when ${shipments.currentStatus} in ('in_transit', 'exception', 'failed_attempt') then interval '30 minutes'
      else interval '2 hours'
    end)`;

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.tenantId, tenantId),
              NON_TERMINAL_PREDICATE,
              // D8's exponential backoff: a shipment that keeps failing waits
              // proportionally longer, so a broken connection cannot starve the
              // sweep of capacity for healthy ones.
              // The explicit cast matters: an untyped `$n - interval` makes
              // Postgres infer the bound Date as an interval and reject it.
              or(
                isNull(shipments.lastPolledAt),
                lt(
                  shipments.lastPolledAt,
                  sql`${now}::timestamptz - (${cadenceCase} * greatest(1, ${shipments.pollFailureCount}))`,
                ),
              ),
            ),
          )
          .orderBy(asc(shipments.lastPolledAt), asc(shipments.id))
          .limit(limit),
      tenantId,
    );
    return (rows as (typeof shipments.$inferSelect)[]).map(toRecord);
  }

  /** `track_order`'s background refresh (D4 Latency): these shipments, under their tenant. */
  async findByIds(tenantId: string, ids: string[]): Promise<ShipmentRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipments)
          .where(
            and(eq(shipments.tenantId, tenantId), inArray(shipments.id, ids)),
          ),
      tenantId,
    );
    return (rows as (typeof shipments.$inferSelect)[]).map(toRecord);
  }

  /** Whether stored state is old enough that `track_order` should enqueue a refresh (D4 Latency). It still answers from stored state either way. */
  static isStale(shipment: ShipmentRecord, now: Date): boolean {
    if (isTerminalStatus(shipment.currentStatus)) return false;
    if (!shipment.lastPolledAt) return true;
    const cadence =
      POLL_CADENCE_MS[shipment.currentStatus] ?? DEFAULT_POLL_CADENCE_MS;
    return now.getTime() - shipment.lastPolledAt.getTime() > cadence;
  }
}

function toRecord(row: typeof shipments.$inferSelect): ShipmentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    customerId: row.customerId,
    courierConnectionId: row.courierConnectionId,
    courier: row.courier as CourierName,
    trackingNumber: row.trackingNumber,
    currentStatus: row.currentStatus as ShipmentStatus,
    currentStatusAt: row.currentStatusAt,
    estimatedDeliveryAt: row.estimatedDeliveryAt,
    deliveredAt: row.deliveredAt,
    lastNotifiedStatus: row.lastNotifiedStatus,
    lastNotifiedAt: row.lastNotifiedAt,
    lastPolledAt: row.lastPolledAt,
    pollFailureCount: row.pollFailureCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
