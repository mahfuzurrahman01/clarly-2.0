import { BadRequestException } from '@nestjs/common';
// F24: Shopify adapter against a stubbed `fetch`, checked against the
// verified reference in docs/integrations/SHOPIFY.md.
import crypto from 'node:crypto';
import type { AppConfigService } from '../../core/config/app-config.service';
import type { AppLoggerService } from '../../core';
import {
  SHOPIFY_ADMIN_API_VERSION,
  ShopifyStoreProvider,
} from './shopify-store.provider';

const SHOP = { shop: 'acme.myshopify.com' };
const CLIENT_SECRET = 'hush';

function makeLogger(warn: jest.Mock = jest.fn()): AppLoggerService {
  return {
    log: jest.fn(),
    warn,
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function makeProvider(logger = makeLogger()): ShopifyStoreProvider {
  return new ShopifyStoreProvider(
    {
      shopifyClientId: 'client-id',
      shopifyClientSecret: CLIENT_SECRET,
      apiPublicBaseUrl: 'https://api.example.com',
    } as unknown as AppConfigService,
    logger,
  );
}

/** Each call to fetch resolves the next body in order (the last one repeats). */
function stubFetch(...bodies: unknown[]): jest.Mock {
  let call = 0;
  const mock = jest.fn().mockImplementation(() => {
    const body = bodies[Math.min(call++, bodies.length - 1)];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  });
  global.fetch = mock;
  return mock;
}

function requestOf(
  mock: jest.Mock,
  index = 0,
): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

function graphqlBody(
  mock: jest.Mock,
  index = 0,
): {
  query: string;
  variables: Record<string, unknown>;
} {
  return JSON.parse(requestOf(mock, index).init.body as string) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

function stubVariant(
  variant: Record<string, unknown>,
  node: Record<string, unknown> = {},
): jest.Mock {
  return stubFetch({
    data: {
      shop: { currencyCode: 'AED' },
      products: {
        edges: [
          {
            cursor: 'c1',
            node: {
              id: 'gid://shopify/Product/1',
              title: 'Oud Perfume',
              variants: { edges: [{ node: { id: 'v1', ...variant } }] },
              ...node,
            },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ShopifyStoreProvider — listProducts stock', () => {
  it('asks Shopify whether each variant tracks inventory', async () => {
    const mock = stubVariant({ inventoryQuantity: 3 });
    await makeProvider().listProducts('tok', undefined, SHOP);
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(init.body as string).toContain('inventoryItem { tracked }');
  });

  it('maps a tracked variant to its count', async () => {
    stubVariant({ inventoryQuantity: 3, inventoryItem: { tracked: true } });
    const { products } = await makeProvider().listProducts(
      'tok',
      undefined,
      SHOP,
    );
    expect(products[0]).toMatchObject({ stock: 3, stockStatus: 'in_stock' });
  });

  it('maps an untracked variant to stock null, in stock — not sold out', async () => {
    stubVariant({ inventoryQuantity: 0, inventoryItem: { tracked: false } });
    const { products } = await makeProvider().listProducts(
      'tok',
      undefined,
      SHOP,
    );
    expect(products[0]).toMatchObject({ stock: null, stockStatus: 'in_stock' });
  });
});

describe('ShopifyStoreProvider — products query (gaps 12-14)', () => {
  it('reads the shop currency in the same request instead of hard-coding SAR', async () => {
    const mock = stubVariant({ price: '10.00' });
    const { products } = await makeProvider().listProducts(
      'tok',
      undefined,
      SHOP,
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(graphqlBody(mock).query).toContain('shop { currencyCode }');
    expect(products[0].currency).toBe('AED');
  });

  it('only syncs active products', async () => {
    const mock = stubVariant({});
    await makeProvider().listProducts('tok', undefined, SHOP);
    expect(graphqlBody(mock).query).toContain('query: "status:active"');
  });

  it('reads the image from featuredMedia, not the deprecated images connection', async () => {
    const mock = stubVariant(
      {},
      { featuredMedia: { preview: { image: { url: 'https://cdn/x.jpg' } } } },
    );
    const { products } = await makeProvider().listProducts(
      'tok',
      undefined,
      SHOP,
    );
    expect(graphqlBody(mock).query).toContain(
      'featuredMedia { preview { image { url } } }',
    );
    expect(graphqlBody(mock).query).not.toContain('images(');
    expect(products[0].imageUrl).toBe('https://cdn/x.jpg');
  });

  it('leaves the image empty while the media preview is not ready', async () => {
    stubVariant({}, { featuredMedia: { preview: { image: null } } });
    const { products } = await makeProvider().listProducts(
      'tok',
      undefined,
      SHOP,
    );
    expect(products[0].imageUrl).toBeUndefined();
  });
});

describe('ShopifyStoreProvider — API version (gap 5)', () => {
  it('pins every GraphQL call to the 2026-10 Admin API', async () => {
    const mock = stubVariant({});
    await makeProvider().listProducts('tok', undefined, SHOP);
    expect(SHOPIFY_ADMIN_API_VERSION).toBe('2026-10');
    expect(requestOf(mock).url).toBe(
      'https://acme.myshopify.com/admin/api/2026-10/graphql.json',
    );
  });
});

describe('ShopifyStoreProvider — OAuth (gaps 6, 17)', () => {
  it('requests exactly the documented scopes', () => {
    const url = new URL(makeProvider().getOAuthAuthorizeUrl('st', SHOP));
    expect(url.searchParams.get('scope')).toBe(
      'read_products,read_inventory,read_orders,read_customers,write_draft_orders',
    );
  });

  it('exchanges the code form-urlencoded with Accept: application/json', async () => {
    const mock = stubFetch({
      access_token: 'shpat_x',
      scope:
        'read_products,read_inventory,read_orders,read_customers,write_draft_orders',
    });
    const tokens = await makeProvider().exchangeCode('the-code', SHOP);

    const { url, init } = requestOf(mock);
    expect(url).toBe('https://acme.myshopify.com/admin/oauth/access_token');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      client_id: 'client-id',
      client_secret: CLIENT_SECRET,
      code: 'the-code',
    });
    expect(tokens).toMatchObject({
      accessToken: 'shpat_x',
      storeId: 'acme.myshopify.com',
    });
  });

  it('warns when the granted scope is missing a required one', async () => {
    const warn = jest.fn();
    const logger = makeLogger(warn);
    stubFetch({ access_token: 'shpat_x', scope: 'read_products,read_orders' });
    await makeProvider(logger).exchangeCode('c', SHOP);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'read_inventory,read_customers,write_draft_orders',
      ),
      'ShopifyStoreProvider',
    );
  });

  it('treats a write_x grant as covering read_x', async () => {
    const warn = jest.fn();
    const logger = makeLogger(warn);
    stubFetch({
      access_token: 'shpat_x',
      scope:
        'write_products,read_inventory,write_orders,read_customers,write_draft_orders',
    });
    await makeProvider(logger).exchangeCode('c', SHOP);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ShopifyStoreProvider — callback hmac (gap 3)', () => {
  /** The official sample from docs/integrations/SHOPIFY.md, verbatim in logic. */
  function officialSampleHmac(query: Record<string, string>): string {
    const params = Object.fromEntries(
      Object.entries(query).filter(([k]) => k !== 'hmac'),
    );
    const message = Object.entries(params)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return crypto
      .createHmac('sha256', CLIENT_SECRET)
      .update(message)
      .digest('hex');
  }

  const base = {
    code: '0907a61c0c8d55e99db179b68161bc00',
    shop: 'some-shop.myshopify.com',
    state: '0.6784241404160823',
    timestamp: '1337178173',
  };

  it("accepts Shopify's long-published example (secret 'hush')", () => {
    expect(
      makeProvider().verifyCallbackSignature({
        ...base,
        hmac: '700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf',
      }),
    ).toBe(true);
  });

  it('agrees with the official sample algorithm, including params we never read', () => {
    const query = { ...base, host: 'YWRtaW4uc2hvcGlmeS5jb20', locale: 'ar' };
    expect(
      makeProvider().verifyCallbackSignature({
        ...query,
        hmac: officialSampleHmac(query),
      }),
    ).toBe(true);
  });

  it('rejects a query tampered with after signing', () => {
    const hmac = officialSampleHmac(base);
    expect(
      makeProvider().verifyCallbackSignature({
        ...base,
        shop: 'attacker.myshopify.com',
        hmac,
      }),
    ).toBe(false);
  });

  it('rejects an added param the signature does not cover', () => {
    const hmac = officialSampleHmac(base);
    expect(
      makeProvider().verifyCallbackSignature({ ...base, extra: '1', hmac }),
    ).toBe(false);
  });

  it('rejects a missing, short or non-string hmac without throwing', () => {
    const provider = makeProvider();
    expect(provider.verifyCallbackSignature(base)).toBe(false);
    expect(provider.verifyCallbackSignature({ ...base, hmac: 'ab' })).toBe(
      false,
    );
    expect(
      provider.verifyCallbackSignature({ ...base, hmac: ['a', 'b'] }),
    ).toBe(false);
  });

  it('rejects everything when no client secret is configured', () => {
    const provider = new ShopifyStoreProvider(
      { shopifyClientSecret: '' } as unknown as AppConfigService,
      makeLogger(),
    );
    expect(
      provider.verifyCallbackSignature({
        ...base,
        hmac: officialSampleHmac(base),
      }),
    ).toBe(false);
  });
});

const ORDER_NODE = {
  id: 'gid://shopify/Order/450789469',
  name: '#1001',
  createdAt: '2026-09-30T10:00:00Z',
  displayFulfillmentStatus: 'UNFULFILLED',
  cancelledAt: null,
  phone: null,
  totalPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'AED' } },
  customer: { defaultPhoneNumber: { phoneNumber: '+971500000000' } },
  shippingAddress: null,
  fulfillments: [],
  lineItems: { edges: [] },
};

describe('ShopifyStoreProvider — order reads (gaps 7-9, 11)', () => {
  it('finds orders through customers(query: "phone:+E164"), not the unfiltered orders search', async () => {
    const mock = stubFetch({
      data: { customers: { nodes: [{ orders: { nodes: [ORDER_NODE] } }] } },
    });

    const orders = await makeProvider().listOrdersByCustomerPhone(
      'tok',
      '+971 50 000 0000',
      SHOP,
    );

    const { query, variables } = graphqlBody(mock);
    expect(query).toContain('customers(first: 1, query: $query)');
    expect(query).toContain('sortKey: CREATED_AT, reverse: true');
    expect(query).not.toMatch(/orders\([^)]*query:/);
    expect(variables).toEqual({ query: 'phone:+971500000000' });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      externalId: '450789469',
      orderNumber: '#1001',
      customerPhone: '+971500000000',
      currency: 'AED',
      status: 'pending',
    });
  });

  it('reads the customer phone from defaultPhoneNumber, not the deprecated Customer.phone', async () => {
    const mock = stubFetch({ data: { order: ORDER_NODE } });
    await makeProvider().getOrder('tok', '450789469', SHOP);
    const { query } = graphqlBody(mock);
    expect(query).toContain('customer { defaultPhoneNumber { phoneNumber } }');
    expect(query).not.toContain('customer { phone }');
  });

  it('makes no call for a phone with no digits', async () => {
    const mock = stubFetch({});
    await expect(
      makeProvider().listOrdersByCustomerPhone('tok', 'n/a', SHOP),
    ).resolves.toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it('still reads an unknown order id (no errors) as not found', async () => {
    stubFetch({ data: { order: null } });
    await expect(makeProvider().getOrder('tok', '1', SHOP)).resolves.toBeNull();
  });

  it('throws on top-level GraphQL errors instead of reading a protected-data refusal as "no orders"', async () => {
    stubFetch({
      data: { customers: { nodes: [{ orders: { nodes: [] } }] } },
      errors: [
        {
          message:
            'This app is not approved to access the Customer object. See https://partners.shopify.com/ for more details.',
        },
      ],
    });
    await expect(
      makeProvider().listOrdersByCustomerPhone('tok', '+971500000000', SHOP),
    ).rejects.toThrow(/Shopify GraphQL error: This app is not approved/);
  });

  it('throws on GraphQL errors for a single-order read too', async () => {
    stubFetch({
      data: { order: null },
      errors: [{ message: 'Access denied for order field.' }],
    });
    await expect(makeProvider().getOrder('tok', '1', SHOP)).rejects.toThrow(
      'Access denied for order field.',
    );
  });

  it.each([
    ['FULFILLED', 'completed'],
    ['FULFILLMENT_NOT_REQUIRED', 'completed'],
    ['IN_PROGRESS', 'processing'],
    ['PENDING_FULFILLMENT', 'processing'],
    ['PARTIALLY_FULFILLED', 'processing'],
    ['SCHEDULED', 'processing'],
    ['ON_HOLD', 'on_hold'],
    ['REQUEST_DECLINED', 'on_hold'],
    ['UNFULFILLED', 'pending'],
    ['OPEN', 'pending'],
    ['RESTOCKED', 'pending'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps displayFulfillmentStatus %s to %s', async (shopify, ours) => {
    stubFetch({
      data: { order: { ...ORDER_NODE, displayFulfillmentStatus: shopify } },
    });
    const order = await makeProvider().getOrder('tok', '1', SHOP);
    expect(order?.status).toBe(ours);
  });

  it('lets cancelledAt outrank the fulfillment status', async () => {
    stubFetch({
      data: {
        order: {
          ...ORDER_NODE,
          displayFulfillmentStatus: 'RESTOCKED',
          cancelledAt: '2026-10-01T00:00:00Z',
        },
      },
    });
    const order = await makeProvider().getOrder('tok', '1', SHOP);
    expect(order?.status).toBe('cancelled');
  });
});

describe('ShopifyStoreProvider — draft order (gaps 15, 16)', () => {
  const ORDER = {
    customerPhone: '+966500000000',
    customerName: 'Sara Al Qahtani',
    shippingAddress: 'King Fahd Rd, Riyadh',
    items: [{ productId: '1', variantId: '42', quantity: 2, price: 10 }],
    notes: 'Gift wrap',
  };
  const DRAFT = {
    data: {
      draftOrderCreate: {
        draftOrder: {
          id: 'gid://shopify/DraftOrder/9',
          invoiceUrl: 'https://acme.myshopify.com/invoices/x',
          totalPriceSet: {
            shopMoney: { amount: '20.00', currencyCode: 'SAR' },
          },
        },
        userErrors: [],
      },
    },
  };

  it('sends the variant GID, the buyer phone on the draft and the address', async () => {
    const mock = stubFetch(DRAFT);
    const result = await makeProvider().createOrder('tok', ORDER, SHOP);

    const { input } = graphqlBody(mock).variables as {
      input: Record<string, unknown>;
    };
    expect(input).toEqual({
      note: 'Gift wrap',
      phone: '+966500000000',
      shippingAddress: {
        address1: 'King Fahd Rd, Riyadh',
        firstName: 'Sara',
        lastName: 'Al Qahtani',
        phone: '+966500000000',
      },
      lineItems: [
        { variantId: 'gid://shopify/ProductVariant/42', quantity: 2 },
      ],
    });
    expect(result).toEqual({
      orderId: '9',
      paymentUrl: 'https://acme.myshopify.com/invoices/x',
      total: 20,
      currency: 'SAR',
    });
  });

  it('fails clearly, with no call, when a line has no variant id (no product-id fallback)', async () => {
    const mock = stubFetch(DRAFT);
    await expect(
      makeProvider().createOrder(
        'tok',
        { ...ORDER, items: [{ productId: '7', quantity: 1, price: 5 }] },
        SHOP,
      ),
    ).rejects.toThrow(/variant id .* product 7/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('still surfaces userErrors when Shopify refuses the draft', async () => {
    stubFetch({
      data: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [{ field: ['lineItems'], message: 'Variant not found' }],
        },
      },
    });
    await expect(
      makeProvider().createOrder('tok', ORDER, SHOP),
    ).rejects.toThrow('Variant not found');
  });
});

describe('ShopifyStoreProvider — webhook registration (gaps 18, 21)', () => {
  const URI =
    'https://api.example.com/store/webhook/shopify/acme.myshopify.com';

  it('creates each missing topic with the uri field, pointed at the per-shop route', async () => {
    const mock = stubFetch(
      { data: { webhookSubscriptions: { nodes: [] } } },
      { data: { webhookSubscriptionCreate: { userErrors: [] } } },
    );

    await makeProvider().registerWebhooks('tok', SHOP);

    expect(graphqlBody(mock, 0).variables).toEqual({ uri: URI });
    const created = mock.mock.calls
      .slice(1)
      .map((_, i) => graphqlBody(mock, i + 1).variables);
    expect(created).toEqual([
      {
        topic: 'PRODUCTS_UPDATE',
        webhookSubscription: { uri: URI, format: 'JSON' },
      },
      {
        topic: 'INVENTORY_LEVELS_UPDATE',
        webhookSubscription: { uri: URI, format: 'JSON' },
      },
      {
        topic: 'ORDERS_CREATE',
        webhookSubscription: { uri: URI, format: 'JSON' },
      },
      {
        topic: 'APP_UNINSTALLED',
        webhookSubscription: { uri: URI, format: 'JSON' },
      },
    ]);
    expect(graphqlBody(mock, 1).query).not.toContain('callbackUrl');
  });

  it('skips topics already subscribed to this URI, so a reconnect does not duplicate them', async () => {
    const mock = stubFetch(
      {
        data: {
          webhookSubscriptions: {
            nodes: [
              { topic: 'PRODUCTS_UPDATE' },
              { topic: 'INVENTORY_LEVELS_UPDATE' },
              { topic: 'ORDERS_CREATE' },
            ],
          },
        },
      },
      { data: { webhookSubscriptionCreate: { userErrors: [] } } },
    );

    await makeProvider().registerWebhooks('tok', SHOP);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(graphqlBody(mock, 1).variables).toMatchObject({
      topic: 'APP_UNINSTALLED',
    });
  });

  it('logs a topic Shopify refuses and carries on with the rest', async () => {
    const warn = jest.fn();
    const logger = makeLogger(warn);
    const mock = stubFetch(
      { data: { webhookSubscriptions: { nodes: [] } } },
      {
        data: {
          webhookSubscriptionCreate: {
            userErrors: [{ field: ['topic'], message: 'Access denied' }],
          },
        },
      },
    );

    await makeProvider(logger).registerWebhooks('tok', SHOP);

    expect(mock).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Access denied'),
      'ShopifyStoreProvider',
    );
  });
});

describe('ShopifyStoreProvider — webhook topics (gaps 20, 21)', () => {
  it('normalizes inventory_levels/update to a re-sync request, not a stock write', () => {
    const event = makeProvider().normalizeWebhookEvent(
      { inventory_item_id: 271878346596884, available: 3 },
      'acme.myshopify.com',
      { 'x-shopify-topic': 'inventory_levels/update' },
    );
    expect(event).toMatchObject({
      eventType: 'inventory_changed',
      externalId: '271878346596884',
    });
  });

  it('normalizes app/uninstalled', () => {
    const event = makeProvider().normalizeWebhookEvent(
      { id: 1, myshopify_domain: 'acme.myshopify.com' },
      'acme.myshopify.com',
      { 'x-shopify-topic': 'app/uninstalled' },
    );
    expect(event?.eventType).toBe('app_uninstalled');
  });

  it('rejects an invalid shop on connect as a 400, not a 500', () => {
    expect(() =>
      makeProvider().connectBinding({ shop: 'evil.example.com' }),
    ).toThrow(BadRequestException);
  });
});
