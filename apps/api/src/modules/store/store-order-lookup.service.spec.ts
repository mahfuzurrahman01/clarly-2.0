// F24 order read-back. The adversarial cases are the point of this file:
// F26 D4's rule is that no customer may retrieve another customer's order,
// and the only thing enforcing it is this service.
import type { AppLoggerService } from '../core';
import type { CustomerService } from '../customer/customer.service';
import type { CustomerRecord } from '../customer/customer.dto';
import { StoreOrderLookupService } from './store-order-lookup.service';
import type {
  StoreConnection,
  StoreConnectionService,
} from './store-connection.service';
import type { StoreOAuthService } from './store-oauth.service';
import type { StoreProviderRegistry } from './store-provider.registry';
import type {
  StoreOrderSummary,
  StoreProvider,
} from './ports/store-provider.port';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';

const CALLER_PHONE = '+966500000000';

const CTX: ToolExecutionContext = {
  tenantId: 'tenant-a',
  conversationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  customerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  turnId: 'turn-1',
};

function makeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function makeConnection(
  overrides: Partial<StoreConnection> = {},
): StoreConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-a',
    provider: 'salla',
    storeId: 'store-1',
    storeName: 'Acme Store',
    storeUrl: 'https://acme.example.com',
    accessToken: 'stored-token',
    refreshToken: null,
    authorizationToken: null,
    tokenExpiresAt: null,
    webhookSecret: null,
    isActive: true,
    lastSyncedAt: null,
    createdAt: new Date('2026-09-20T00:00:00Z'),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeOrder(
  overrides: Partial<StoreOrderSummary> = {},
): StoreOrderSummary {
  return {
    externalId: '1234',
    orderNumber: '#1234',
    status: 'processing',
    placedAt: new Date('2026-09-01T00:00:00Z'),
    total: 500,
    currency: 'SAR',
    customerPhone: CALLER_PHONE,
    trackingNumber: null,
    items: [{ name: 'Oud Perfume', quantity: 2, price: 250 }],
    ...overrides,
  };
}

function makeHarness(options: {
  connections?: StoreConnection[];
  customer?: CustomerRecord | null;
  getOrder?: jest.Mock;
  listOrders?: jest.Mock;
}) {
  const getOrder = options.getOrder ?? jest.fn().mockResolvedValue(null);
  const listOrdersByCustomerPhone =
    options.listOrders ?? jest.fn().mockResolvedValue([]);
  const adapter = {
    getOrder,
    listOrdersByCustomerPhone,
  } as unknown as StoreProvider;

  const connectionService = {
    findActiveByTenant: jest
      .fn()
      .mockResolvedValue(options.connections ?? [makeConnection()]),
  } as unknown as StoreConnectionService;
  const oauthService = {
    ensureCredentials: jest
      .fn()
      .mockResolvedValue({ accessToken: 'fresh-token' }),
  } as unknown as StoreOAuthService;
  const getCustomer = jest
    .fn()
    .mockResolvedValue(
      options.customer === undefined
        ? ({ id: CTX.customerId, phone: CALLER_PHONE } as CustomerRecord)
        : options.customer,
    );
  const customerService = { getCustomer } as unknown as CustomerService;
  const registry = {
    forProvider: jest.fn().mockReturnValue(adapter),
  } as unknown as StoreProviderRegistry;

  return {
    service: new StoreOrderLookupService(
      connectionService,
      oauthService,
      customerService,
      registry,
      makeLogger(),
    ),
    getOrder,
    listOrdersByCustomerPhone,
    getCustomer,
    connectionService,
  };
}

describe('StoreOrderLookupService — scoping (the security property)', () => {
  it('takes the phone from the platform’s own customer row, never from an argument', async () => {
    const { service, getCustomer, listOrdersByCustomerPhone } = makeHarness({
      listOrders: jest.fn().mockResolvedValue([makeOrder()]),
    });

    await service.listForCaller(CTX);

    expect(getCustomer).toHaveBeenCalledWith('tenant-a', CTX.customerId);
    expect(listOrdersByCustomerPhone).toHaveBeenCalledWith(
      'fresh-token',
      CALLER_PHONE,
      expect.anything(),
    );
  });

  it('fails closed when the turn has no customer (comment reply, eval harness)', async () => {
    const { service, connectionService, listOrdersByCustomerPhone } =
      makeHarness({ listOrders: jest.fn().mockResolvedValue([makeOrder()]) });

    const orders = await service.listForCaller({ ...CTX, customerId: null });

    expect(orders).toEqual([]);
    expect(listOrdersByCustomerPhone).not.toHaveBeenCalled();
    expect(connectionService.findActiveByTenant).not.toHaveBeenCalled();
  });

  it('fails closed on a findForCaller with no customer in context', async () => {
    const { service, getOrder } = makeHarness({
      getOrder: jest.fn().mockResolvedValue(makeOrder()),
    });

    await expect(
      service.findForCaller({ ...CTX, customerId: null }, '1234'),
    ).resolves.toBeNull();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('fails closed when the customer row has gone (or belongs to another tenant)', async () => {
    const { service, listOrdersByCustomerPhone } = makeHarness({
      customer: null,
      listOrders: jest.fn().mockResolvedValue([makeOrder()]),
    });

    await expect(service.listForCaller(CTX)).resolves.toEqual([]);
    expect(listOrdersByCustomerPhone).not.toHaveBeenCalled();
  });

  it('DROPS an order the store returned for a different customer', async () => {
    const { service } = makeHarness({
      listOrders: jest
        .fn()
        .mockResolvedValue([
          makeOrder({ externalId: 'mine' }),
          makeOrder({ externalId: 'theirs', customerPhone: '+966511111111' }),
        ]),
    });

    const orders = await service.listForCaller(CTX);

    expect(orders.map((o) => o.externalId)).toEqual(['mine']);
  });

  it('DROPS an order the store returned with no phone at all', async () => {
    const { service } = makeHarness({
      listOrders: jest
        .fn()
        .mockResolvedValue([makeOrder({ customerPhone: null })]),
    });

    await expect(service.listForCaller(CTX)).resolves.toEqual([]);
  });

  it('refuses another customer’s order by reference, indistinguishably from "no such order"', async () => {
    const { service } = makeHarness({
      getOrder: jest
        .fn()
        .mockResolvedValue(makeOrder({ customerPhone: '+966511111111' })),
    });

    const theirs = await service.findForCaller(CTX, '1234');
    expect(theirs).toBeNull();

    const missing = await makeHarness({
      getOrder: jest.fn().mockResolvedValue(null),
    }).service.findForCaller(CTX, '9999');
    expect(missing).toBeNull();
  });

  it('matches a store that recorded the number in local format', async () => {
    const { service } = makeHarness({
      getOrder: jest
        .fn()
        .mockResolvedValue(makeOrder({ customerPhone: '0500000000' })),
    });

    await expect(service.findForCaller(CTX, '1234')).resolves.toMatchObject({
      externalId: '1234',
    });
  });
});

describe('StoreOrderLookupService — behaviour', () => {
  it('attributes each order to the store it came from', async () => {
    const { service } = makeHarness({
      listOrders: jest.fn().mockResolvedValue([makeOrder()]),
    });

    const [order] = await service.listForCaller(CTX);

    expect(order).toMatchObject({
      provider: 'salla',
      storeName: 'Acme Store',
      storeConnectionId: 'conn-1',
    });
  });

  it('merges every connected store, newest order first', async () => {
    const listOrders = jest
      .fn()
      .mockResolvedValueOnce([
        makeOrder({ externalId: 'old', placedAt: new Date('2026-01-01') }),
      ])
      .mockResolvedValueOnce([
        makeOrder({ externalId: 'new', placedAt: new Date('2026-09-10') }),
      ]);
    const { service } = makeHarness({
      connections: [
        makeConnection({ id: 'conn-1' }),
        makeConnection({ id: 'conn-2', provider: 'woocommerce' }),
      ],
      listOrders,
    });

    const orders = await service.listForCaller(CTX);

    expect(orders.map((o) => o.externalId)).toEqual(['new', 'old']);
  });

  it('tolerates a `#` prefix on the reference the customer quoted', async () => {
    const getOrder = jest.fn().mockResolvedValue(makeOrder());
    const { service } = makeHarness({ getOrder });

    await service.findForCaller(CTX, ' #1234 ');

    expect(getOrder).toHaveBeenCalledWith(
      'fresh-token',
      '1234',
      expect.anything(),
    );
  });

  it('falls back to the caller’s own history when the reference is a human order NUMBER', async () => {
    const { service } = makeHarness({
      getOrder: jest.fn().mockResolvedValue(null),
      listOrders: jest
        .fn()
        .mockResolvedValue([
          makeOrder({ externalId: 'internal-9', orderNumber: '#1234' }),
        ]),
    });

    await expect(service.findForCaller(CTX, '#1234')).resolves.toMatchObject({
      externalId: 'internal-9',
    });
  });

  it('refuses an empty reference without calling any store', async () => {
    const { service, getOrder } = makeHarness({});
    await expect(service.findForCaller(CTX, '  #  ')).resolves.toBeNull();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('carries the per-connection host so Shopify/WooCommerce know which site to call', async () => {
    const { service, listOrdersByCustomerPhone } = makeHarness({
      listOrders: jest.fn().mockResolvedValue([]),
    });

    await service.listForCaller(CTX);

    expect(listOrdersByCustomerPhone).toHaveBeenCalledWith(
      'fresh-token',
      CALLER_PHONE,
      { shop: 'store-1', siteUrl: 'https://acme.example.com' },
    );
  });

  it('lets one broken store fail without losing the other store’s answer', async () => {
    const listOrders = jest
      .fn()
      .mockRejectedValueOnce(new Error('Salla order list failed: 503'))
      .mockResolvedValueOnce([makeOrder({ externalId: 'from-healthy' })]);
    const { service } = makeHarness({
      connections: [
        makeConnection({ id: 'conn-1' }),
        makeConnection({ id: 'conn-2' }),
      ],
      listOrders,
    });

    const orders = await service.listForCaller(CTX);

    expect(orders.map((o) => o.externalId)).toEqual(['from-healthy']);
  });
});
