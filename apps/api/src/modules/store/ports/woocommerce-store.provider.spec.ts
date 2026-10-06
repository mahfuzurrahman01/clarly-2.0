// F24: WooCommerce adapter. Everything here is exercised against a stubbed
// `fetch` — no call has ever been made from this repo to a real WooCommerce
// install, so these tests pin the SHAPE we send and the mapping we apply, not
// that a live site accepts them.
import { createHmac } from 'node:crypto';
import type { AppConfigService } from '../../core/config/app-config.service';
import { WooCommerceStoreProvider } from './woocommerce-store.provider';

const SITE = { siteUrl: 'https://shop.example.com' };

function makeConfig(): AppConfigService {
  return {
    woocommerceAppName: 'Clarly',
    woocommerceCallbackUrl:
      'https://api.example.com/store/callback/woocommerce',
    consoleBaseUrl: 'https://app.example.com',
    apiPublicBaseUrl: 'https://api.example.com',
  } as unknown as AppConfigService;
}

function makeProvider(): WooCommerceStoreProvider {
  return new WooCommerceStoreProvider(makeConfig());
}

function stubFetch(
  response: Partial<{
    ok: boolean;
    status: number;
    json: unknown;
    headers: Record<string, string>;
  }>,
): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: () => Promise.resolve(response.json ?? {}),
    headers: {
      get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
    },
  });
  global.fetch = mock;
  return mock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('WooCommerceStoreProvider — identity', () => {
  it('is registered under the woocommerce provider name', () => {
    expect(makeProvider().provider).toBe('woocommerce');
  });

  it("declares WooCommerce's own signature header, not an invented one", () => {
    expect(makeProvider().webhookSignatureHeader).toBe(
      'x-wc-webhook-signature',
    );
  });
});

describe('WooCommerceStoreProvider — authorize URL', () => {
  it('points at the merchant’s own site, not a platform host', () => {
    const url = new URL(
      makeProvider().getOAuthAuthorizeUrl('signed-state', SITE),
    );
    expect(url.origin).toBe('https://shop.example.com');
    expect(url.pathname).toBe('/wc-auth/v1/authorize');
  });

  it('carries the signed state in user_id, because /wc-auth has no state param', () => {
    const url = new URL(
      makeProvider().getOAuthAuthorizeUrl('signed-state', SITE),
    );
    expect(url.searchParams.get('user_id')).toBe('signed-state');
    expect(url.searchParams.get('state')).toBeNull();
    expect(url.searchParams.get('callback_url')).toBe(
      'https://api.example.com/store/callback/woocommerce',
    );
    expect(url.searchParams.get('scope')).toBe('read_write');
  });

  it('accepts the site via `shop` too, which is where store_connections.store_id lands', () => {
    const url = new URL(
      makeProvider().getOAuthAuthorizeUrl('s', { shop: 'shop.example.com' }),
    );
    expect(url.origin).toBe('https://shop.example.com');
  });

  it('refuses a site that is not a plain host — the value is interpolated into a credential-bearing URL', () => {
    const provider = makeProvider();
    expect(() => provider.getOAuthAuthorizeUrl('s', { siteUrl: '' })).toThrow(
      /Invalid WooCommerce site/,
    );
    expect(() =>
      provider.getOAuthAuthorizeUrl('s', { siteUrl: 'http://evil' }),
    ).toThrow(/Invalid WooCommerce site/);
  });

  it('strips a scheme and path so only the host is ever used', () => {
    const url = new URL(
      makeProvider().getOAuthAuthorizeUrl('s', {
        siteUrl: 'https://shop.example.com/some/path',
      }),
    );
    expect(url.origin).toBe('https://shop.example.com');
  });
});

describe('WooCommerceStoreProvider — credential exchange', () => {
  it('shapes the callback’s key pair into a connection without any network call', async () => {
    const fetchMock = stubFetch({});
    const tokens = await makeProvider().exchangeCode('ck_abc:cs_def', SITE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokens).toEqual({
      accessToken: 'ck_abc:cs_def',
      storeId: 'shop.example.com',
      storeName: 'shop.example.com',
      storeUrl: 'https://shop.example.com',
    });
  });

  it('refuses a callback that did not carry both halves of the pair', async () => {
    await expect(
      makeProvider().exchangeCode('ck_abc_only', SITE),
    ).rejects.toThrow(/consumer_key\/consumer_secret/);
  });

  it('has no refresh grant — WooCommerce keys are permanent', async () => {
    await expect(makeProvider().refreshAccessToken()).resolves.toBeNull();
  });
});

describe('WooCommerceStoreProvider — products', () => {
  it('authenticates with HTTP Basic over the consumer key/secret pair', async () => {
    const fetchMock = stubFetch({
      json: [],
      headers: { 'x-wp-totalpages': '1' },
    });
    await makeProvider().listProducts('ck_abc:cs_def', undefined, SITE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(typeof url).toBe('string');
    expect(url).toContain('https://shop.example.com/wp-json/wc/v3/products');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('ck_abc:cs_def').toString('base64')}`,
    );
  });

  it('maps a product and pages on X-WP-TotalPages, since there is no cursor', async () => {
    stubFetch({
      json: [
        {
          id: 42,
          name: 'Oud Perfume',
          price: '250.00',
          sku: 'OUD-1',
          stock_quantity: 7,
          stock_status: 'instock',
          images: ['https://shop.example.com/oud.jpg'],
          categories: [{ name: 'Perfume' }],
        },
      ],
      headers: { 'x-wp-totalpages': '3' },
    });

    const result = await makeProvider().listProducts('ck:cs', undefined, SITE);

    expect(result.products[0]).toMatchObject({
      externalId: '42',
      name: 'Oud Perfume',
      price: 250,
      stock: 7,
      stockStatus: 'in_stock',
      sku: 'OUD-1',
      category: 'Perfume',
    });
    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).toBe('2');
  });

  it('trusts stock_status over a null quantity, so stock-managed-off products stay purchasable', async () => {
    stubFetch({
      json: [
        {
          id: 1,
          name: 'Unmanaged',
          price: '10',
          stock_quantity: null,
          stock_status: 'instock',
        },
      ],
      headers: { 'x-wp-totalpages': '1' },
    });
    const result = await makeProvider().listProducts('ck:cs', undefined, SITE);
    expect(result.products[0].stockStatus).toBe('in_stock');
    expect(result.products[0].stock).toBeNull();
  });

  it('reports stock null when stock management is off, whatever the quantity says', async () => {
    stubFetch({
      json: [
        {
          id: 1,
          name: 'Unmanaged',
          price: '10',
          manage_stock: false,
          stock_quantity: 5,
          stock_status: 'instock',
        },
      ],
      headers: { 'x-wp-totalpages': '1' },
    });
    const result = await makeProvider().listProducts('ck:cs', undefined, SITE);
    expect(result.products[0]).toMatchObject({
      stock: null,
      stockStatus: 'in_stock',
    });
  });

  it('maps a backorder to pre_order rather than in_stock', async () => {
    stubFetch({
      json: [
        {
          id: 1,
          name: 'Backordered',
          price: '10',
          stock_status: 'onbackorder',
        },
      ],
      headers: { 'x-wp-totalpages': '1' },
    });
    const result = await makeProvider().listProducts('ck:cs', undefined, SITE);
    expect(result.products[0].stockStatus).toBe('pre_order');
  });

  it('throws on a non-2xx rather than reporting an empty catalogue', async () => {
    stubFetch({ ok: false, status: 401 });
    await expect(
      makeProvider().listProducts('ck:cs', undefined, SITE),
    ).rejects.toThrow(/WooCommerce products list failed: 401/);
  });
});

describe('WooCommerceStoreProvider — orders', () => {
  const ORDER = {
    id: 1234,
    number: '1234',
    status: 'processing',
    total: '500.00',
    currency: 'SAR',
    date_created: '2026-09-01T10:00:00',
    billing: { phone: '0500000000' },
    line_items: [{ name: 'Oud Perfume', quantity: 2, price: '250.00' }],
  };

  it('creates a COD order with WooCommerce line_items', async () => {
    const fetchMock = stubFetch({ json: { ...ORDER, payment_url: '' } });
    const result = await makeProvider().createOrder(
      'ck:cs',
      {
        customerName: 'Sara',
        customerPhone: '+966500000000',
        shippingAddress: 'Riyadh',
        items: [{ productId: '42', quantity: 2, price: 250 }],
      },
      SITE,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.payment_method).toBe('cod');
    expect(body.set_paid).toBe(false);
    expect(body.line_items).toEqual([{ product_id: 42, quantity: 2 }]);
    expect(result).toMatchObject({
      orderId: '1234',
      total: 500,
      currency: 'SAR',
    });
  });

  it('reads one order back and normalizes its status', async () => {
    stubFetch({ json: ORDER });
    const order = await makeProvider().getOrder('ck:cs', '1234', SITE);

    expect(order).toMatchObject({
      externalId: '1234',
      orderNumber: '1234',
      status: 'processing',
      total: 500,
      currency: 'SAR',
      customerPhone: '0500000000',
    });
    expect(order?.items).toEqual([
      { name: 'Oud Perfume', quantity: 2, price: 250 },
    ]);
  });

  it('returns null for an unknown order instead of throwing', async () => {
    stubFetch({ ok: false, status: 404 });
    await expect(
      makeProvider().getOrder('ck:cs', 'nope', SITE),
    ).resolves.toBeNull();
  });

  it('lists a phone’s orders from the bare array WooCommerce returns', async () => {
    const fetchMock = stubFetch({ json: [ORDER] });
    const orders = await makeProvider().listOrdersByCustomerPhone(
      'ck:cs',
      '+966500000000',
      SITE,
    );

    const [listUrl] = fetchMock.mock.calls[0] as [string];
    expect(listUrl).toContain('search=');
    expect(orders).toHaveLength(1);
    expect(orders[0].externalId).toBe('1234');
  });
});

describe('WooCommerceStoreProvider — webhooks', () => {
  const SECRET = 'wc-secret';

  function sign(body: Buffer): string {
    return createHmac('sha256', SECRET).update(body).digest('base64');
  }

  it('verifies a base64 HMAC-SHA256 over the raw body', () => {
    const body = Buffer.from('{"id":7}');
    expect(
      makeProvider().verifyWebhookSignature(body, sign(body), SECRET),
    ).toBe(true);
  });

  it('rejects a forged signature without throwing on a length mismatch', () => {
    const body = Buffer.from('{"id":7}');
    expect(makeProvider().verifyWebhookSignature(body, 'short', SECRET)).toBe(
      false,
    );
  });

  it('uses the per-connection secret and refuses when there is none', () => {
    expect(makeProvider().resolveWebhookSecret('abc')).toBe('abc');
    expect(makeProvider().resolveWebhookSecret('')).toBeNull();
    expect(makeProvider().resolveWebhookSecret(null)).toBeNull();
  });

  it('keys idempotency on the per-delivery header', () => {
    expect(
      makeProvider().extractEventId({}, { 'x-wc-webhook-delivery-id': 'd-9' }),
    ).toBe('d-9');
  });

  it('falls back to topic + resource id when there is no delivery id', () => {
    expect(
      makeProvider().extractEventId(
        {},
        {
          'x-wc-webhook-topic': 'product.updated',
          'x-wc-webhook-resource-id': '42',
        },
      ),
    ).toBe('product.updated:42');
  });

  it('reads the topic from the header, never the body', () => {
    const event = makeProvider().normalizeWebhookEvent(
      { id: 42 },
      'shop.example.com',
      {
        'x-wc-webhook-topic': 'product.updated',
      },
    );
    expect(event).toMatchObject({
      eventType: 'product_updated',
      externalId: '42',
    });
  });

  it('returns null when no topic header is present at all', () => {
    expect(
      makeProvider().normalizeWebhookEvent({ id: 42 }, 'shop.example.com', {}),
    ).toBeNull();
  });

  it('normalizes an unrecognised topic to unknown rather than guessing', () => {
    const event = makeProvider().normalizeWebhookEvent({ id: 1 }, 'shop', {
      'x-wc-webhook-topic': 'coupon.deleted',
    });
    expect(event?.eventType).toBe('unknown');
  });
});
