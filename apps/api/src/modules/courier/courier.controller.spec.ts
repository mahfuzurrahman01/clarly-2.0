// F26 (D1/D9, D10): the console API.
//
// The headline test is D1's: credentials are validated LIVE before the
// connection goes active. F24 shipped connections that had never made a real
// provider call, which is how "no Salla call has ever been made" became a
// launch blocker.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuditDetail } from '../audit/audit-detail';
import type { TenantAuthContext } from '../auth/jwt-claims';
import type { OrderService } from '../order/order.service';
import type { CourierConnectionService } from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import { CourierController } from './courier.controller';
import type { DeliveryNotificationSettingsService } from './delivery-notification-settings.service';
import type { ShipmentService } from './shipment.service';
import {
  CourierAuthenticationError,
  CourierConnector,
  type CourierTrackingResult,
} from './ports/courier-connector.port';
import {
  createShipmentSchema,
  updateDeliveryNotificationSettingsSchema,
  upsertCourierConnectionSchema,
} from './courier.dto';

const TENANT = 'tenant-a';
const auth = { tenantId: TENANT, userId: 'user-1' } as TenantAuthContext;
const audit = { describe: jest.fn() } as unknown as AuditDetail;

class StubConnector extends CourierConnector {
  constructor(
    readonly courier: 'aramex' | 'jt',
    readonly webhookSignatureHeader: string | null,
    private readonly verify: () => Promise<void>,
  ) {
    super();
  }
  verifyCredentials(): Promise<void> {
    return this.verify();
  }
  track(): Promise<CourierTrackingResult[]> {
    return Promise.resolve([]);
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

function makeController(
  options: {
    verify?: () => Promise<void>;
    courier?: 'aramex' | 'jt';
    webhookHeader?: string | null;
    connection?: unknown;
    order?: unknown;
  } = {},
) {
  const connector = new StubConnector(
    options.courier ?? 'aramex',
    options.webhookHeader === undefined ? null : options.webhookHeader,
    options.verify ?? (() => Promise.resolve()),
  );
  const registry = {
    forCourier: () => connector,
  } as unknown as CourierConnectorRegistry;

  const upsert = jest.fn((input: { isActive: boolean }) =>
    Promise.resolve({
      id: 'conn-1',
      tenantId: TENANT,
      courier: options.courier ?? 'aramex',
      accountRef: 'ACC-1',
      credentials: {},
      webhookSecret: null,
      isActive: input.isActive,
      lastVerifiedAt: input.isActive ? new Date() : null,
      lastPolledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );

  const connections = {
    upsert,
    findByTenant: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(
      options.connection === undefined
        ? {
            id: 'conn-1',
            courier: options.courier ?? 'aramex',
            webhookSecret: null,
            isActive: true,
          }
        : options.connection,
    ),
    deactivate: jest.fn().mockResolvedValue(true),
    rotateWebhookSecret: jest.fn().mockResolvedValue('new-secret'),
  } as unknown as CourierConnectionService;

  const shipments = {
    findByOrder: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue([]),
    create: jest.fn((input: { trackingNumber: string; courier: string }) =>
      Promise.resolve({
        id: 'shipment-1',
        orderId: 'order-1',
        courier: input.courier,
        trackingNumber: input.trackingNumber,
        currentStatus: 'label_created',
        currentStatusAt: null,
        estimatedDeliveryAt: null,
        deliveredAt: null,
        lastNotifiedStatus: null,
        lastNotifiedAt: null,
        lastPolledAt: null,
        pollFailureCount: 0,
      }),
    ),
  } as unknown as ShipmentService;

  const orders = {
    get: jest.fn().mockResolvedValue(
      options.order === undefined
        ? {
            order: {
              id: 'order-1',
              reference: 'ORD-1',
              customerId: 'customer-1',
            },
            items: [],
          }
        : options.order,
    ),
  } as unknown as OrderService;

  const settings = {
    get: jest.fn().mockResolvedValue({
      tenantId: TENANT,
      enabled: false,
      statusTemplates: {},
      updatedAt: null,
    }),
    upsert: jest.fn((tenantId: string, input: unknown) =>
      Promise.resolve({
        tenantId,
        ...(input as object),
        updatedAt: new Date(),
      }),
    ),
  } as unknown as DeliveryNotificationSettingsService;

  const controller = new CourierController(
    connections,
    registry,
    shipments,
    settings,
    orders,
  );

  return { controller, connections, shipments, settings, orders, upsert };
}

const body = {
  courier: 'aramex' as const,
  accountRef: 'ACC-1',
  credentials: { username: 'u', password: 'p' },
};

describe('CourierController — credential validation (D1)', () => {
  it('stores the connection active once the courier accepted the credentials', async () => {
    const { controller, upsert } = makeController();

    const result = await controller.upsertConnection(auth, body, audit);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, isActive: true }),
    );
    expect(result.isActive).toBe(true);
    expect(result).not.toHaveProperty('verificationError');
  });

  it('stores it INACTIVE and reports why when the courier rejected them', async () => {
    const { controller, upsert } = makeController({
      verify: () =>
        Promise.reject(
          new CourierAuthenticationError('aramex', 'bad password'),
        ),
    });

    const result = await controller.upsertConnection(auth, body, audit);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
    expect(result.isActive).toBe(false);
    expect(result.verificationError).toMatch(/bad password/);
  });

  it('does not activate on a courier outage either', async () => {
    const { controller, upsert } = makeController({
      verify: () => Promise.reject(new Error('ETIMEDOUT')),
    });

    await controller.upsertConnection(auth, body, audit);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  // A stored secret for a courier we refuse push from would look like a
  // configuration gap rather than the decision it is (D1).
  it('mints a webhook secret only for a courier whose push we accept', async () => {
    const pollOnly = makeController();
    await pollOnly.controller.upsertConnection(auth, body, audit);
    expect(pollOnly.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ webhookSecret: null }),
    );

    const pushCapable = makeController({
      courier: 'jt',
      webhookHeader: 'digest',
    });
    await pushCapable.controller.upsertConnection(
      auth,
      { ...body, courier: 'jt' },
      audit,
    );
    expect(pushCapable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('never returns credentials or the secret in a listing', async () => {
    const { controller, connections } = makeController();
    (connections.findByTenant as jest.Mock).mockResolvedValue([
      {
        id: 'conn-1',
        courier: 'aramex',
        accountRef: 'ACC-1',
        credentials: { password: 'super-secret' },
        webhookSecret: 'whsec-secret',
        isActive: true,
        lastVerifiedAt: null,
        lastPolledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const listed = await controller.listConnections(auth);

    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('whsec-secret');
    expect(listed[0].hasWebhookSecret).toBe(true);
  });
});

describe('CourierController — not-found paths (D9)', () => {
  it('404s rather than throwing a bare Error for an unknown connection', async () => {
    const { controller, connections } = makeController();
    (connections.deactivate as jest.Mock).mockResolvedValue(false);

    await expect(
      controller.deactivate(auth, 'conn-x', audit),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to mint a webhook secret for a poll-only courier', async () => {
    const { controller } = makeController();

    await expect(
      controller.rotateWebhookSecret(auth, 'conn-1', audit),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rotates and reveals the secret once for a push-capable courier', async () => {
    const { controller } = makeController({
      courier: 'jt',
      webhookHeader: 'digest',
      connection: { id: 'conn-1', courier: 'jt', webhookSecret: null },
    });

    await expect(
      controller.rotateWebhookSecret(auth, 'conn-1', audit),
    ).resolves.toEqual({ webhookSecret: 'new-secret' });
  });
});

describe('CourierController — request validation (D9)', () => {
  it('rejects a courier name outside the supported four', () => {
    expect(
      upsertCourierConnectionSchema.safeParse({ ...body, courier: 'dhl' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty credential map', () => {
    expect(
      upsertCourierConnectionSchema.safeParse({ ...body, credentials: {} })
        .success,
    ).toBe(false);
  });

  // Only statuses worth a billed message may be mapped.
  it('rejects mapping a template to a status that is never notified', () => {
    expect(
      updateDeliveryNotificationSettingsSchema.safeParse({
        enabled: true,
        statusTemplates: {
          in_transit: '22222222-2222-4333-8444-555555555555',
        },
      }).success,
    ).toBe(false);
    expect(
      updateDeliveryNotificationSettingsSchema.safeParse({
        enabled: true,
        statusTemplates: {
          delivered: '22222222-2222-4333-8444-555555555555',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a template id that is not a uuid', () => {
    expect(
      updateDeliveryNotificationSettingsSchema.safeParse({
        enabled: true,
        statusTemplates: { delivered: 'not-a-uuid' },
      }).success,
    ).toBe(false);
  });
});

const shipmentBody = {
  courier: 'aramex' as const,
  courierConnectionId: 'conn-1',
  trackingNumber: 'AWB-123',
};

describe('CourierController — manual shipment creation', () => {
  it('creates a shipment against a tenant-scoped order with an active matching connection', async () => {
    const { controller, shipments, orders } = makeController();

    const result = await controller.createShipment(
      auth,
      'order-1',
      shipmentBody,
      audit,
    );

    expect(orders.get).toHaveBeenCalledWith(TENANT, 'order-1');
    expect(shipments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        orderId: 'order-1',
        customerId: 'customer-1',
        courierConnectionId: 'conn-1',
        courier: 'aramex',
        trackingNumber: 'AWB-123',
      }),
    );
    expect(result.trackingNumber).toBe('AWB-123');
    expect(result.id).toBe('shipment-1');
  });

  it('404s when the order does not exist in this tenant', async () => {
    const { controller } = makeController({ order: null });

    await expect(
      controller.createShipment(auth, 'order-x', shipmentBody, audit),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when the courier connection does not exist in this tenant', async () => {
    const { controller, connections } = makeController();
    (connections.findById as jest.Mock).mockResolvedValue(null);

    await expect(
      controller.createShipment(auth, 'order-1', shipmentBody, audit),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an inactive courier connection', async () => {
    const { controller } = makeController({
      connection: {
        id: 'conn-1',
        courier: 'aramex',
        webhookSecret: null,
        isActive: false,
      },
    });

    await expect(
      controller.createShipment(auth, 'order-1', shipmentBody, audit),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a connection whose courier does not match the body', async () => {
    const { controller } = makeController({
      connection: {
        id: 'conn-1',
        courier: 'smsa',
        webhookSecret: null,
        isActive: true,
      },
    });

    await expect(
      controller.createShipment(auth, 'order-1', shipmentBody, audit),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a body with an unsupported courier name', () => {
    expect(
      createShipmentSchema.safeParse({ ...shipmentBody, courier: 'dhl' })
        .success,
    ).toBe(false);
  });

  it('rejects an empty tracking number', () => {
    expect(
      createShipmentSchema.safeParse({ ...shipmentBody, trackingNumber: '' })
        .success,
    ).toBe(false);
  });
});
