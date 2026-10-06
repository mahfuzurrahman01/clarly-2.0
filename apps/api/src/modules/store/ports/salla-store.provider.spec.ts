// F24: Salla adapter. Everything here runs against a stubbed `fetch`, so these
// tests pin the SHAPE we send and the mapping we apply per
// docs/integrations/SALLA.md, not that a live Salla store accepts them.
import type { AppConfigService } from '../../core/config/app-config.service';
import { SallaStoreProvider } from './salla-store.provider';

function makeConfig(): AppConfigService {
  return {
    sallaClientId: 'client-id',
    sallaClientSecret: 'client-secret',
    sallaRedirectUri: 'https://api.example.com/store/callback/salla',
  } as unknown as AppConfigService;
}

function makeProvider(): SallaStoreProvider {
  return new SallaStoreProvider(makeConfig());
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  json?: unknown;
}

function respond(response: StubResponse) {
  return {
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: () => Promise.resolve(response.json ?? {}),
  };
}

/** Serves the given responses in call order. */
function stubFetch(...responses: StubResponse[]): jest.Mock {
  const mock = jest.fn();
  for (const response of responses) {
    mock.mockResolvedValueOnce(respond(response));
  }
  global.fetch = mock;
  return mock;
}

function bodyOf(mock: jest.Mock, call = 0): Record<string, unknown> {
  const [, init] = mock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SallaStoreProvider — authorize URL', () => {
  it('requests only offline_access; permissions come from the portal App Scope', () => {
    const url = new URL(makeProvider().getOAuthAuthorizeUrl('signed-state'));
    expect(url.origin + url.pathname).toBe(
      'https://accounts.salla.sa/oauth2/auth',
    );
    expect(url.searchParams.get('scope')).toBe('offline_access');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('SallaStoreProvider — code exchange', () => {
  const TOKEN = {
    access_token: 'ory_at_abc',
    refresh_token: 'ory_rt_def',
    expires: 1209599,
    token_type: 'bearer',
  };
  const USER_INFO = {
    status: 200,
    success: true,
    data: {
      id: 1771165749,
      merchant: {
        id: 1803665367,
        name: 'Abaya House',
        domain: 'https://salla.sa/abaya-house',
      },
    },
  };

  it('reads the store identity from /oauth2/user/info, since the token has none', async () => {
    const fetchMock = stubFetch({ json: TOKEN }, { json: USER_INFO });
    const before = Date.now();

    const tokens = await makeProvider().exchangeCode('the-code');

    const [infoUrl, infoInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(infoUrl).toBe('https://accounts.salla.sa/oauth2/user/info');
    expect((infoInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer ory_at_abc',
    );
    expect(tokens).toMatchObject({
      accessToken: 'ory_at_abc',
      refreshToken: 'ory_rt_def',
      storeId: '1803665367',
      storeName: 'Abaya House',
      storeUrl: 'https://salla.sa/abaya-house',
    });
    // `expires` is a lifetime in seconds (~14 days).
    const lifetime = (tokens.expiresAt?.getTime() ?? 0) - before;
    expect(lifetime).toBeGreaterThanOrEqual(1209599 * 1000 - 1000);
    expect(lifetime).toBeLessThanOrEqual(1209599 * 1000 + 1000);
  });

  it('refuses to connect a store with no merchant id rather than saving an empty storeId', async () => {
    stubFetch({ json: TOKEN }, { json: { data: { id: 1, merchant: {} } } });
    await expect(makeProvider().exchangeCode('the-code')).rejects.toThrow(
      /merchant id/,
    );
  });

  it('throws when user info itself fails', async () => {
    stubFetch({ json: TOKEN }, { ok: false, status: 401 });
    await expect(makeProvider().exchangeCode('the-code')).rejects.toThrow(
      /Salla user info failed: 401/,
    );
  });

  it('reads `expires` on refresh too', async () => {
    stubFetch({ json: { ...TOKEN, refresh_token: 'ory_rt_new' } });
    const tokens = await makeProvider().refreshAccessToken('ory_rt_old');
    expect(tokens.refreshToken).toBe('ory_rt_new');
    expect(tokens.expiresAt).toBeInstanceOf(Date);
  });
});

describe('SallaStoreProvider — products', () => {
  const PRODUCT = {
    id: 123456789,
    name: 'Black Abaya',
    sku: 'ABY-1',
    price: { amount: 249.5, currency: 'SAR' },
    quantity: 7,
    status: 'sale',
    images: [
      { id: 1, url: 'https://cdn.salla.sa/side.jpg', main: false },
      { id: 2, url: 'https://cdn.salla.sa/main.jpg', main: true },
    ],
    categories: [
      { id: 1, name: 'Abayas' },
      { id: 2, name: 'New' },
    ],
  };

  it('calls the /admin/v2 products endpoint with per_page', async () => {
    const fetchMock = stubFetch({ json: { data: [] } });
    await makeProvider().listProducts('tok');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://api.salla.dev/admin/v2/products',
    );
    expect(parsed.searchParams.get('page')).toBe('1');
    expect(parsed.searchParams.get('per_page')).toBe('50');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
  });

  it('maps price.amount, quantity, the main image and the first category', async () => {
    stubFetch({ json: { data: [PRODUCT] } });
    const { products } = await makeProvider().listProducts('tok');

    expect(products[0]).toMatchObject({
      externalId: '123456789',
      name: 'Black Abaya',
      price: 249.5,
      currency: 'SAR',
      stock: 7,
      stockStatus: 'in_stock',
      imageUrl: 'https://cdn.salla.sa/main.jpg',
      sku: 'ABY-1',
      category: 'Abayas',
    });
  });

  it('falls back to the first image when none is marked main, and to SAR when no currency', async () => {
    stubFetch({
      json: {
        data: [
          {
            ...PRODUCT,
            price: { amount: '10' },
            images: [{ url: 'https://cdn.salla.sa/a.jpg' }],
          },
        ],
      },
    });
    const { products } = await makeProvider().listProducts('tok');
    expect(products[0]).toMatchObject({
      price: 10,
      currency: 'SAR',
      imageUrl: 'https://cdn.salla.sa/a.jpg',
    });
  });

  it('treats a null quantity as unlimited stock (in stock), not sold out', async () => {
    stubFetch({ json: { data: [{ ...PRODUCT, quantity: null }] } });
    const { products } = await makeProvider().listProducts('tok');
    expect(products[0].stockStatus).toBe('in_stock');
    expect(products[0].stock).toBeNull();
  });

  it('keeps an untracked product with status "out" out of stock', async () => {
    stubFetch({
      json: { data: [{ ...PRODUCT, quantity: null, status: 'out' }] },
    });
    const { products } = await makeProvider().listProducts('tok');
    expect(products[0]).toMatchObject({
      stock: null,
      stockStatus: 'out_of_stock',
    });
  });

  it('trusts status "out" over a positive quantity', async () => {
    stubFetch({ json: { data: [{ ...PRODUCT, status: 'out' }] } });
    const { products } = await makeProvider().listProducts('tok');
    expect(products[0].stockStatus).toBe('out_of_stock');
  });

  it('reports out_of_stock for a zero quantity', async () => {
    stubFetch({ json: { data: [{ ...PRODUCT, quantity: 0 }] } });
    const { products } = await makeProvider().listProducts('tok');
    expect(products[0].stockStatus).toBe('out_of_stock');
  });

  it('pages on pagination.{currentPage,totalPages}', async () => {
    stubFetch({
      json: { data: [], pagination: { currentPage: 2, totalPages: 3 } },
    });
    const result = await makeProvider().listProducts('tok', '2');
    expect(result).toMatchObject({ hasNextPage: true, nextCursor: '3' });
  });

  it('pages on pagination.links.next', async () => {
    stubFetch({
      json: {
        data: [],
        pagination: { currentPage: 1, links: { next: 'https://x?page=2' } },
      },
    });
    const result = await makeProvider().listProducts('tok');
    expect(result).toMatchObject({ hasNextPage: true, nextCursor: '2' });
  });

  it('pages on pagination.{current,next}', async () => {
    stubFetch({
      json: {
        data: [],
        pagination: { count: 20, current: 1, next: 'https://x?page=2' },
      },
    });
    const result = await makeProvider().listProducts('tok');
    expect(result).toMatchObject({ hasNextPage: true, nextCursor: '2' });
  });

  it('stops on the last page', async () => {
    stubFetch({
      json: {
        data: [],
        pagination: {
          currentPage: 3,
          totalPages: 3,
          links: {},
          current: 3,
          next: null,
        },
      },
    });
    const result = await makeProvider().listProducts('tok', '3');
    expect(result).toMatchObject({ hasNextPage: false });
    expect(result.nextCursor).toBeUndefined();
  });

  it('throws on a non-2xx rather than reporting an empty catalogue', async () => {
    stubFetch({ ok: false, status: 401 });
    await expect(makeProvider().listProducts('tok')).rejects.toThrow(
      /Salla products list failed: 401/,
    );
  });
});

describe('SallaStoreProvider — create order', () => {
  const ORDER = {
    customerName: 'Sara',
    customerPhone: '+966501234567',
    shippingAddress: 'Al Olaya, Riyadh',
    items: [{ productId: '123', quantity: 2, price: 249.5 }],
  };
  const CREATED = {
    status: 201,
    success: true,
    data: {
      id: 1107722485,
      urls: {
        customer: 'https://salla.sa/abaya-house/account/orders/XArYbdA',
        admin: 'https://s.salla.sa/orders/order/x',
      },
      amounts: { total: { amount: 499, currency: 'SAR' } },
    },
  };

  it('posts products[] with identifier_type, a pending_payment, a receiver and ship_to', async () => {
    const fetchMock = stubFetch({ status: 201, json: CREATED });
    await makeProvider().createOrder('tok', ORDER);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.salla.dev/admin/v2/orders');
    const body = bodyOf(fetchMock);
    expect(body.products).toEqual([
      { identifier_type: 'id', identifier: '123', quantity: 2 },
    ]);
    expect(body.payment).toEqual({
      status: 'pending_payment',
      accepted_methods: ['cod'],
    });
    expect(body.receiver).toEqual({
      name: 'Sara',
      country_code: 'SA',
      phone: '501234567',
    });
    expect(body.customer).toBeUndefined();
    expect(body.delivery_method).toBe('shipping');
    expect(body.ship_to).toEqual({ address: 'Al Olaya, Riyadh' });
    expect(body.items).toBeUndefined();
  });

  it('uses customer.id when the caller already has a Salla customer', async () => {
    const fetchMock = stubFetch({ status: 201, json: CREATED });
    await makeProvider().createOrder('tok', { ...ORDER, customerId: '1994' });
    const body = bodyOf(fetchMock);
    expect(body.customer).toEqual({ id: '1994' });
    expect(body.receiver).toBeUndefined();
  });

  it('splits a non-Saudi Gulf number by its dial code', async () => {
    const fetchMock = stubFetch({ status: 201, json: CREATED });
    await makeProvider().createOrder('tok', {
      ...ORDER,
      customerPhone: '00971 50 123 4567',
    });
    expect(bodyOf(fetchMock).receiver).toMatchObject({
      country_code: 'AE',
      phone: '501234567',
    });
  });

  it('reads the order id, customer link and total from the response', async () => {
    stubFetch({ status: 201, json: CREATED });
    const result = await makeProvider().createOrder('tok', ORDER);
    expect(result).toEqual({
      orderId: '1107722485',
      paymentUrl: 'https://salla.sa/abaya-house/account/orders/XArYbdA',
      total: 499,
      currency: 'SAR',
    });
  });

  it("puts Salla's own error message into the thrown error", async () => {
    stubFetch({
      ok: false,
      status: 422,
      json: {
        status: 422,
        success: false,
        error: {
          code: 'error',
          message: 'alert.invalid_fields',
          fields: { 'customer.email': ['The email field is required.'] },
        },
      },
    });
    await expect(makeProvider().createOrder('tok', ORDER)).rejects.toThrow(
      /Salla order creation failed: 422 .*alert\.invalid_fields.*customer\.email/,
    );
  });

  it('still throws a status-only error when the error body is not JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    });
    await expect(makeProvider().createOrder('tok', ORDER)).rejects.toThrow(
      /Salla order creation failed: 500/,
    );
  });

  it('throws when the response carries no order id', async () => {
    stubFetch({ status: 201, json: { data: {} } });
    await expect(makeProvider().createOrder('tok', ORDER)).rejects.toThrow(
      /no order id/,
    );
  });
});

describe('SallaStoreProvider — order reads', () => {
  it('reads orders from the /admin/v2 base', async () => {
    const fetchMock = stubFetch({ ok: false, status: 404 });
    await makeProvider().getOrder('tok', '900321');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.salla.dev/admin/v2/orders/900321');
  });
});
