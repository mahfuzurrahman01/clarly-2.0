// F26 (D5/D8, D10): the poll sweep.
//
// What matters here is not that it polls, but HOW it fails: a rejected
// credential must deactivate the connection and tell the merchant (retrying
// it is how an account gets locked out), while a transport failure must back
// off and only escalate once it has been failing for a while. F24's store
// sync did neither and went quietly stale.
import type { AppLoggerService } from '../core';
import type { NotificationService } from '../notifications/notifications.module';
import type { TenantDirectoryService } from '../tenant-context/tenant-directory';
import type { CourierConnectionService } from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import type { DeliveryNotificationQueueService } from './delivery-notification.queue-service';
import { ShipmentPollService } from './shipment-poll.service';
import {
  POLL_FAILURE_ALERT_THRESHOLD,
  type ShipmentRecord,
  type ShipmentService,
} from './shipment.service';
import {
  CourierAuthenticationError,
  CourierConnector,
  type CourierTrackingResult,
} from './ports/courier-connector.port';
import { NoopCourierConnector } from './ports/noop-courier.connector';
import { SHIPMENT_POLL_BATCH_LIMIT } from './shipment-poll.queue';

const TENANT = 'tenant-a';

function logger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function shipment(overrides: Partial<ShipmentRecord> = {}): ShipmentRecord {
  return {
    id: 'ship-1',
    tenantId: TENANT,
    orderId: 'order-1',
    customerId: 'customer-1',
    courierConnectionId: 'conn-1',
    courier: 'aramex',
    trackingNumber: 'AWB-1',
    currentStatus: 'in_transit',
    currentStatusAt: null,
    estimatedDeliveryAt: null,
    deliveredAt: null,
    lastNotifiedStatus: null,
    lastNotifiedAt: null,
    lastPolledAt: null,
    pollFailureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A stand-in adapter whose `track` the test controls. */
class FakeConnector extends CourierConnector {
  readonly courier = 'aramex' as const;
  readonly webhookSignatureHeader = null;
  constructor(
    private readonly impl: (
      credentials: Record<string, string>,
      trackingNumbers: string[],
    ) => Promise<CourierTrackingResult[]>,
  ) {
    super();
  }
  verifyCredentials(): Promise<void> {
    return Promise.resolve();
  }
  track(
    credentials: Record<string, string>,
    trackingNumbers: string[],
  ): Promise<CourierTrackingResult[]> {
    return this.impl(credentials, trackingNumbers);
  }
  verifyWebhookSignature(): boolean {
    return false;
  }
  extractEventId(): string | null {
    return null;
  }
  normalizeWebhookEvent(): null {
    return null;
  }
}

function makeHarness(options: {
  due?: ShipmentRecord[];
  track?: (
    credentials: Record<string, string>,
    trackingNumbers: string[],
  ) => Promise<CourierTrackingResult[]>;
  applied?: unknown;
  connections?: unknown[];
  tenantIds?: string[];
}) {
  const due = options.due ?? [shipment()];
  const trackImpl =
    options.track ??
    (() =>
      Promise.resolve([
        {
          trackingNumber: 'AWB-1',
          currentStatus: 'out_for_delivery' as const,
          events: [
            {
              status: 'out_for_delivery' as const,
              rawStatus: 'SH005',
              occurredAt: new Date(),
            },
          ],
        },
      ]));

  const connector = new FakeConnector(trackImpl);
  const registry = {
    forCourier: () => connector,
  } as unknown as CourierConnectorRegistry;

  const shipments = {
    findDueForPoll: jest.fn().mockResolvedValue(due),
    findByIds: jest.fn().mockResolvedValue(due),
    applyStatusEvents: jest.fn().mockResolvedValue(
      options.applied ?? {
        shipmentId: 'ship-1',
        newEventCount: 1,
        previousStatus: 'in_transit',
        currentStatus: 'out_for_delivery',
        notifiableTransition: true,
      },
    ),
    recordPollFailure: jest.fn().mockResolvedValue(undefined),
  };

  const connections = {
    findActiveByTenant: jest.fn().mockResolvedValue(
      options.connections ?? [
        {
          id: 'conn-1',
          tenantId: TENANT,
          courier: 'aramex',
          accountRef: 'ACC-1',
          credentials: { username: 'u' },
          webhookSecret: null,
          isActive: true,
        },
      ],
    ),
    markPolled: jest.fn().mockResolvedValue(undefined),
    markCredentialsRejected: jest.fn().mockResolvedValue(undefined),
  };

  const notificationQueue = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const notifications = {
    record: jest.fn().mockResolvedValue(true),
  };

  const tenants = {
    listTenantIds: jest.fn().mockResolvedValue(options.tenantIds ?? [TENANT]),
  };

  // The mocks stay typed as mocks (so assertions read `jest.Mock`s, not
  // unbound service methods); only the constructor sees the service types.
  const service = new ShipmentPollService(
    shipments as unknown as ShipmentService,
    connections as unknown as CourierConnectionService,
    registry,
    notificationQueue as unknown as DeliveryNotificationQueueService,
    notifications as unknown as NotificationService,
    tenants as unknown as TenantDirectoryService,
    logger(),
  );

  return {
    service,
    shipments,
    connections,
    notificationQueue,
    notifications,
    tenants,
  };
}

describe('ShipmentPollService — the happy path', () => {
  it('applies the courier’s events and enqueues the notification', async () => {
    const { service, shipments, notificationQueue, connections } = makeHarness(
      {},
    );

    const outcome = await service.sweep();

    expect(outcome).toMatchObject({ shipmentsPolled: 1, statusChanges: 1 });
    expect(shipments.applyStatusEvents).toHaveBeenCalledWith(
      TENANT,
      'ship-1',
      expect.anything(),
      'poll',
      undefined,
    );
    expect(notificationQueue.enqueue).toHaveBeenCalledWith(
      TENANT,
      'ship-1',
      'out_for_delivery',
    );
    expect(connections.markPolled).toHaveBeenCalledWith(TENANT, 'conn-1');
  });

  // FORCE RLS: a platform-wide read returns nothing, so the sweep must
  // enter each open tenant and ask for ITS due shipments and connections.
  it('lists open tenants and reads due shipments and connections per tenant', async () => {
    const { service, shipments, connections, tenants } = makeHarness({});
    const now = new Date('2026-10-06T10:00:00Z');

    await service.sweep(now);

    expect(tenants.listTenantIds).toHaveBeenCalledWith();
    expect(shipments.findDueForPoll).toHaveBeenCalledWith(
      TENANT,
      now,
      SHIPMENT_POLL_BATCH_LIMIT,
    );
    expect(connections.findActiveByTenant).toHaveBeenCalledWith(TENANT);
  });

  it('sweeps every tenant and sums the outcome across them', async () => {
    const tenantB = 'tenant-b';
    const { service, shipments, connections } = makeHarness({
      tenantIds: [TENANT, tenantB],
    });
    shipments.findDueForPoll.mockImplementation((tenantId: string) =>
      Promise.resolve([
        shipment({
          id: `ship-${tenantId}`,
          tenantId,
          courierConnectionId: `conn-${tenantId}`,
        }),
      ]),
    );
    connections.findActiveByTenant.mockImplementation((tenantId: string) =>
      Promise.resolve([
        {
          id: `conn-${tenantId}`,
          tenantId,
          courier: 'aramex',
          accountRef: `ACC-${tenantId}`,
          credentials: { username: 'u' },
          webhookSecret: null,
          isActive: true,
        },
      ]),
    );

    const outcome = await service.sweep();

    expect(outcome).toMatchObject({ shipmentsPolled: 2, statusChanges: 2 });
    expect(shipments.findDueForPoll).toHaveBeenCalledTimes(2);
    expect(connections.findActiveByTenant).toHaveBeenCalledWith(TENANT);
    expect(connections.findActiveByTenant).toHaveBeenCalledWith(tenantB);
    expect(shipments.applyStatusEvents).toHaveBeenCalledWith(
      tenantB,
      `ship-${tenantB}`,
      expect.anything(),
      'poll',
      undefined,
    );
    expect(connections.markPolled).toHaveBeenCalledWith(
      tenantB,
      `conn-${tenantB}`,
    );
  });

  it('keeps sweeping the other tenants when one tenant’s read fails', async () => {
    const { service, shipments } = makeHarness({
      tenantIds: ['tenant-broken', TENANT],
    });
    shipments.findDueForPoll.mockImplementation((tenantId: string) =>
      tenantId === 'tenant-broken'
        ? Promise.reject(new Error('connection reset'))
        : Promise.resolve([shipment()]),
    );

    const outcome = await service.sweep();

    expect(outcome.shipmentsPolled).toBe(1);
  });

  it('does nothing when there are no tenants', async () => {
    const { service, shipments } = makeHarness({ tenantIds: [] });

    const outcome = await service.sweep();

    expect(outcome).toEqual({
      shipmentsPolled: 0,
      statusChanges: 0,
      connectionsFailed: 0,
    });
    expect(shipments.findDueForPoll).not.toHaveBeenCalled();
  });

  // Batching per connection is what lets Aramex's array-taking
  // `TrackShipments` be ONE call for a merchant's whole in-flight set.
  it('makes one call per connection, not one per parcel', async () => {
    const calls: string[][] = [];
    const { service } = makeHarness({
      due: [
        shipment({ id: 'ship-1', trackingNumber: 'AWB-1' }),
        shipment({ id: 'ship-2', trackingNumber: 'AWB-2' }),
        shipment({ id: 'ship-3', trackingNumber: 'AWB-3' }),
      ],
      track: (_credentials, trackingNumbers) => {
        calls.push(trackingNumbers);
        return Promise.resolve([]);
      },
    });

    await service.sweep();

    expect(calls).toEqual([['AWB-1', 'AWB-2', 'AWB-3']]);
  });

  it('ignores a result for a waybill it did not ask about', async () => {
    const { service, shipments } = makeHarness({
      track: () =>
        Promise.resolve([
          {
            trackingNumber: 'SOMEONE-ELSES-AWB',
            currentStatus: 'delivered' as const,
            events: [
              {
                status: 'delivered' as const,
                rawStatus: 'SH014',
                occurredAt: new Date(),
              },
            ],
          },
        ]),
    });

    const outcome = await service.sweep();

    expect(outcome.shipmentsPolled).toBe(0);
    expect(shipments.applyStatusEvents).not.toHaveBeenCalled();
  });

  it('enqueues nothing when the status did not move forward', async () => {
    const { service, notificationQueue } = makeHarness({
      applied: {
        shipmentId: 'ship-1',
        newEventCount: 0,
        previousStatus: 'in_transit',
        currentStatus: 'in_transit',
        notifiableTransition: false,
      },
    });

    await service.sweep();

    expect(notificationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('skips a shipment whose connection is no longer active', async () => {
    const { service, shipments } = makeHarness({ connections: [] });

    const outcome = await service.sweep();

    expect(outcome.shipmentsPolled).toBe(0);
    // Not a failure either — there is simply nothing to ask.
    expect(shipments.recordPollFailure).not.toHaveBeenCalled();
  });

  it('does nothing at all when nothing is due', async () => {
    const { service, connections } = makeHarness({ due: [] });

    const outcome = await service.sweep();

    expect(outcome).toEqual({
      shipmentsPolled: 0,
      statusChanges: 0,
      connectionsFailed: 0,
    });
    expect(connections.findActiveByTenant).not.toHaveBeenCalled();
  });

  it('refreshes a caller-chosen set through the same path', async () => {
    const { service, shipments, connections, tenants } = makeHarness({});

    await service.refresh(TENANT, ['ship-1']);

    expect(shipments.findByIds).toHaveBeenCalledWith(TENANT, ['ship-1']);
    expect(connections.findActiveByTenant).toHaveBeenCalledWith(TENANT);
    expect(shipments.applyStatusEvents).toHaveBeenCalled();
    // A refresh is one tenant's set — it never fans out across tenants.
    expect(tenants.listTenantIds).not.toHaveBeenCalled();
  });
});

describe('ShipmentPollService — failure handling (D8)', () => {
  it('deactivates the connection and tells the merchant when credentials are rejected', async () => {
    const { service, connections, notifications, shipments } = makeHarness({
      track: () =>
        Promise.reject(new CourierAuthenticationError('aramex', '401')),
    });

    const outcome = await service.sweep();

    expect(outcome.connectionsFailed).toBe(1);
    expect(connections.markCredentialsRejected).toHaveBeenCalledWith(
      TENANT,
      'conn-1',
    );
    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'courier_connection_failing',
        severity: 'critical',
      }),
    );
    // A credential rejection is not a transient poll failure.
    expect(shipments.recordPollFailure).not.toHaveBeenCalled();
  });

  it('counts a transport failure and stays quiet below the threshold', async () => {
    const { service, shipments, notifications } = makeHarness({
      track: () => Promise.reject(new Error('ETIMEDOUT')),
    });

    await service.sweep();

    expect(shipments.recordPollFailure).toHaveBeenCalledWith(TENANT, [
      'ship-1',
    ]);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  // Never serve stale state quietly.
  it('tells the merchant once the connection has been failing for a while', async () => {
    const { service, notifications } = makeHarness({
      due: [shipment({ pollFailureCount: POLL_FAILURE_ALERT_THRESHOLD - 1 })],
      track: () => Promise.reject(new Error('ETIMEDOUT')),
    });

    await service.sweep();

    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'courier_connection_failing',
        severity: 'warning',
      }),
    );
  });
});

describe('CourierConnectorRegistry', () => {
  it('falls back to the fail-closed adapter for an unknown courier', () => {
    const noop = new NoopCourierConnector(logger());
    const stub = () =>
      new FakeConnector(() =>
        Promise.resolve([]),
      ) as unknown as ConstructorParameters<typeof CourierConnectorRegistry>[0];
    const registry = new CourierConnectorRegistry(
      stub(),
      stub() as unknown as ConstructorParameters<
        typeof CourierConnectorRegistry
      >[1],
      stub() as unknown as ConstructorParameters<
        typeof CourierConnectorRegistry
      >[2],
      stub() as unknown as ConstructorParameters<
        typeof CourierConnectorRegistry
      >[3],
      noop,
    );

    expect(registry.forCourier('dhl')).toBe(noop);
    expect(registry.forCourier('aramex')).not.toBe(noop);
  });
});
