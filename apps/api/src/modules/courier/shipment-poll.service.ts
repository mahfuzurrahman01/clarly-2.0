// F26 (Delivery Tracking): the poll sweep's logic (D5).
//
// Polling is the DESIGN, not a fallback: three of the four couriers have no
// push surface we will accept (D1), so the J&T webhook is an accelerator on
// top of this, and both converge on the same
// `ShipmentService.applyStatusEvents()`.
//
// The tenant boundary: this is a platform-wide job with no request and
// therefore no tenant context. It lists tenant ids (TenantDirectoryService —
// `tenants` is the one table readable without one) and polls each tenant
// inside its own `withTenantTx`, with bounded concurrency and per-tenant
// failure isolation. It used to read `shipments` and `courier_connections`
// platform-wide through `runAdminQuery`; under FORCE RLS and a NOBYPASSRLS
// role that read returned nothing, so no shipment was ever polled (fixed in
// Clarly 2.0). Nothing in this module injects a raw DB handle.
//
// Batching is per `courier_connection_id`, so a batch-capable courier
// (Aramex's `TrackShipments` takes an array) makes one call for a merchant's
// whole in-flight set rather than one per parcel.
import { Injectable } from '@nestjs/common';
import { AppLoggerService, sweepTenantsWithBoundedConcurrency } from '../core';
import { TenantDirectoryService } from '../tenant-context/tenant-directory';
import { NotificationService } from '../notifications/notification-record.module';
import { notificationContent } from '../notifications/notification-content';
import { CourierCallGuard } from './courier-call';
import {
  CourierConnectionService,
  type CourierConnection,
} from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import { DeliveryNotificationQueueService } from './delivery-notification.queue-service';
import {
  POLL_FAILURE_ALERT_THRESHOLD,
  ShipmentService,
  type ShipmentRecord,
} from './shipment.service';
import {
  CourierAuthenticationError,
  type CourierTrackingResult,
} from './ports/courier-connector.port';
import { SHIPMENT_POLL_BATCH_LIMIT } from './shipment-poll.queue';

export interface PollOutcome {
  shipmentsPolled: number;
  statusChanges: number;
  connectionsFailed: number;
}

@Injectable()
export class ShipmentPollService {
  private readonly guard = new CourierCallGuard();

  constructor(
    private readonly shipments: ShipmentService,
    private readonly connections: CourierConnectionService,
    private readonly registry: CourierConnectorRegistry,
    private readonly notificationQueue: DeliveryNotificationQueueService,
    private readonly notifications: NotificationService,
    private readonly tenants: TenantDirectoryService,
    private readonly logger: AppLoggerService,
  ) {}

  /** The repeatable job's body: per tenant, every non-terminal shipment whose per-status cadence has elapsed. */
  async sweep(now: Date = new Date()): Promise<PollOutcome> {
    const tenantIds = await this.tenants.listTenantIds();
    const results = await sweepTenantsWithBoundedConcurrency(
      tenantIds,
      async (tenantId) =>
        this.poll(
          tenantId,
          await this.shipments.findDueForPoll(
            tenantId,
            now,
            SHIPMENT_POLL_BATCH_LIMIT,
          ),
        ),
      { logger: this.logger, sweepName: 'shipment-poll' },
    );
    return results.reduce<PollOutcome>(
      (total, { value }) => ({
        shipmentsPolled: total.shipmentsPolled + value.shipmentsPolled,
        statusChanges: total.statusChanges + value.statusChanges,
        connectionsFailed: total.connectionsFailed + value.connectionsFailed,
      }),
      { shipmentsPolled: 0, statusChanges: 0, connectionsFailed: 0 },
    );
  }

  /** `track_order`'s background refresh (D4 Latency): the same path, a caller-chosen set. */
  async refresh(tenantId: string, shipmentIds: string[]): Promise<PollOutcome> {
    const shipments = await this.shipments.findByIds(tenantId, shipmentIds);
    return this.poll(tenantId, shipments);
  }

  private async poll(
    tenantId: string,
    shipments: ShipmentRecord[],
  ): Promise<PollOutcome> {
    const outcome: PollOutcome = {
      shipmentsPolled: 0,
      statusChanges: 0,
      connectionsFailed: 0,
    };
    if (shipments.length === 0) return outcome;

    // One read of the tenant's active connections, then an in-memory index:
    // the alternative is a connection read per shipment, and a merchant with
    // 300 parcels in flight would do 300 of them.
    const active = await this.connections.findActiveByTenant(tenantId);
    const byId = new Map(active.map((c) => [c.id, c]));

    for (const [connectionId, batch] of groupByConnection(shipments)) {
      const connection = byId.get(connectionId);
      if (!connection) {
        // The connection was deactivated (bad credentials, or the merchant
        // disconnected). Not an error and not a poll failure — there is
        // simply nothing to ask.
        continue;
      }
      const result = await this.pollConnection(connection, batch);
      outcome.shipmentsPolled += result.shipmentsPolled;
      outcome.statusChanges += result.statusChanges;
      outcome.connectionsFailed += result.connectionsFailed;
    }

    return outcome;
  }

  private async pollConnection(
    connection: CourierConnection,
    batch: ShipmentRecord[],
  ): Promise<PollOutcome> {
    const outcome: PollOutcome = {
      shipmentsPolled: 0,
      statusChanges: 0,
      connectionsFailed: 0,
    };
    const connector = this.registry.forCourier(connection.courier);
    const byTrackingNumber = new Map(
      batch.map((shipment) => [shipment.trackingNumber, shipment]),
    );

    let results: CourierTrackingResult[];
    try {
      // One breaker per (courier, connection): one merchant's broken account
      // must not open the circuit for every other merchant on that courier.
      results = await this.guard.run(
        `${connection.courier}:${connection.id}`,
        () =>
          connector.track(connection.credentials, [...byTrackingNumber.keys()]),
      );
    } catch (error) {
      outcome.connectionsFailed = 1;
      await this.handlePollFailure(connection, batch, error);
      return outcome;
    }

    await this.connections.markPolled(connection.tenantId, connection.id);

    for (const result of results) {
      const shipment = byTrackingNumber.get(result.trackingNumber);
      // A courier answering about a waybill we did not ask for is not an
      // error, but it is certainly not something to write against a guess.
      if (!shipment) continue;

      outcome.shipmentsPolled += 1;
      const applied = await this.shipments.applyStatusEvents(
        shipment.tenantId,
        shipment.id,
        result.events,
        'poll',
        result.estimatedDeliveryAt,
      );
      if (applied?.notifiableTransition) {
        outcome.statusChanges += 1;
        await this.notificationQueue.enqueue(
          shipment.tenantId,
          shipment.id,
          applied.currentStatus,
        );
      }
    }

    return outcome;
  }

  /**
   * D8's two failure classes, which get opposite treatment:
   *   - credentials rejected  -> deactivate the connection, tell the
   *     merchant, stop polling its shipments. Retrying a rejected credential
   *     is how an account gets locked out.
   *   - anything else         -> count the failure, back off (the sweep's own
   *     SQL multiplies the cadence by the failure count), and tell the
   *     merchant once the count crosses the threshold rather than letting the
   *     data go quietly stale.
   */
  private async handlePollFailure(
    connection: CourierConnection,
    batch: ShipmentRecord[],
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);

    if (error instanceof CourierAuthenticationError) {
      await this.connections.markCredentialsRejected(
        connection.tenantId,
        connection.id,
      );
      await this.notifications.record({
        tenantId: connection.tenantId,
        ...notificationContent.courierCredentialsRejected({
          courier: connection.courier,
        }),
        severity: 'critical',
        entityType: 'courier_connection',
        entityId: connection.id,
        dedupKey: `courier-auth:${connection.id}`,
      });
      this.logger.error(
        `courier connection ${connection.id} (${connection.courier}) deactivated after a credential rejection`,
        'ShipmentPollService',
      );
      return;
    }

    await this.shipments.recordPollFailure(
      connection.tenantId,
      batch.map((shipment) => shipment.id),
    );

    const worst = Math.max(...batch.map((s) => s.pollFailureCount)) + 1;
    if (worst >= POLL_FAILURE_ALERT_THRESHOLD) {
      await this.notifications.record({
        tenantId: connection.tenantId,
        ...notificationContent.courierPollFailing({
          courier: connection.courier,
          attempts: worst,
        }),
        severity: 'warning',
        entityType: 'courier_connection',
        entityId: connection.id,
        // One notification per connection per day, not one per sweep.
        dedupKey: `courier-poll:${connection.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }

    this.logger.warn(
      `polling ${connection.courier} connection ${connection.id} failed (${batch.length} shipment(s)): ${detail}`,
      'ShipmentPollService',
    );
  }
}

function groupByConnection(
  shipments: ShipmentRecord[],
): Map<string, ShipmentRecord[]> {
  const grouped = new Map<string, ShipmentRecord[]>();
  for (const shipment of shipments) {
    const existing = grouped.get(shipment.courierConnectionId);
    if (existing) existing.push(shipment);
    else grouped.set(shipment.courierConnectionId, [shipment]);
  }
  return grouped;
}
