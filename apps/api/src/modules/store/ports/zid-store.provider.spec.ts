// F24: Zid adapter. Everything here runs against a stubbed `fetch`, so these
// tests pin the SHAPE we send and the mapping we apply per
// docs/integrations/ZID.md (fixtures from docs.zid.sa's response examples),
// not that a live Zid store accepts them. No Zid call has been made.
import type { AppConfigService } from '../../core/config/app-config.service';
import type { AppLoggerService } from '../../core';
import {
  ZID_WEBHOOK_EVENTS,
  ZidOrderInputError,
  ZidStoreProvider,
  rateLimitDelayMs,
} from './zid-store.provider';
import { ZID_ORDER_RESPONSE } from './__fixtures__/store-responses';
import {
  ZID_CREATE_WEBHOOK_RESPONSE,
  ZID_ORDER_LIST_RESPONSE,
  ZID_PRODUCT_LIST_RESPONSE,
  ZID_PROFILE_RESPONSE,
  ZID_TOKEN_RESPONSE,
  ZID_UNAUTHORIZED_RESPONSE,
} from './__fixtures__/zid-responses';

const CONTEXT = { shop: '3', authorizationToken: 'zid-partner-token' };

function makeConfig(overrides: Record<string, string> = {}): AppConfigService {
  return {
    zidClientId: 'client-id',
    zidClientSecret: 'client-secret',
    zidRedirectUri: 'https://api.example.com/store/callback/zid',
    zidAppId: '2404',
    apiPublicBaseUrl: 'https://api.example.com',
    ...overrides,
  } as unknown as AppConfigService;
}

function makeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function makeProvider(
  config: Record<string, string> = {},
  logger = makeLogger(),
): ZidStoreProvider {
  return new ZidStoreProvider(makeConfig(config), logger);
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

function respond(response: StubResponse) {
  const status = response.status ?? 200;
  return {
    ok: response.ok ?? (status >= 200 && status < 300),
    status,
    headers: new Headers(response.headers ?? {}),
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

function callOf(
  mock: jest.Mock,
  call = 0,
): { url: URL; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = mock.mock.calls[call] as [string, RequestInit];
  return {
    url: new URL(url),
    init,
    headers: (init.headers ?? {}) as Record<string, string>,
  };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('ZidStoreProvider — authorize URL', () => {
  it('sends client_id, redirect_uri, response_type and state, and no scope', () => {
    const url = new URL(makeProvider().getOAuthAuthorizeUrl('signed-state'));
    expect(url.origin + url.pathname).toBe(
      'https://oauth.zid.sa/oauth/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/store/callback/zid',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('ZidStoreProvider — code exchange', () => {
  it('keeps both tokens and reads the store identity from the manager profile', async () => {
    const fetchMock = stubFetch(
      { json: ZID_TOKEN_RESPONSE },
      { json: ZID_PROFILE_RESPONSE },
    );

    const tokens = await makeProvider().exchangeCode('auth-code');

    expect(tokens).toMatchObject({
      accessToken: 'zid-manager-token',
      authorizationToken: 'zid-partner-token',
      refreshToken: 'zid-refresh-token',
      storeId: '3',
      storeName: 'متجر أسامة.',
      storeUrl: 'https://osama.zid.store/',
    });
    expect(tokens.expiresAt).toBeInstanceOf(Date);

    const token = callOf(fetchMock, 0);
    expect(token.url.toString()).toBe('https://oauth.zid.sa/oauth/token');
    const form = new URLSearchParams(token.init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: 'https://api.example.com/store/callback/zid',
      grant_type: 'authorization_code',
      code: 'auth-code',
    });

    const profile = callOf(fetchMock, 1);
    expect(profile.url.toString()).toBe(
      'https://api.zid.sa/v1/managers/account/profile',
    );
    expect(profile.headers).toMatchObject({
      Authorization: 'Bearer zid-partner-token',
      'X-Manager-Token': 'zid-manager-token',
    });
  });

  it('accepts the partner token spelled `Authorization`, as the docs prose writes it', async () => {
    const { authorization, ...rest } = ZID_TOKEN_RESPONSE;
    stubFetch(
      { json: { ...rest, Authorization: authorization } },
      { json: ZID_PROFILE_RESPONSE },
    );

    await expect(makeProvider().exchangeCode('code')).resolves.toMatchObject({
      authorizationToken: 'zid-partner-token',
    });
  });

  it('fails without the partner token instead of storing a connection that can never call Zid', async () => {
    const { authorization: _dropped, ...rest } = ZID_TOKEN_RESPONSE;
    void _dropped;
    stubFetch({ json: rest });

    await expect(makeProvider().exchangeCode('code')).rejects.toThrow(
      'no authorization token',
    );
  });

  it('fails when the profile has no store id (it keys the connection and the webhook route)', async () => {
    stubFetch({ json: ZID_TOKEN_RESPONSE }, { json: { user: { store: {} } } });

    await expect(makeProvider().exchangeCode('code')).rejects.toThrow(
      'no store id',
    );
  });
});

describe('ZidStoreProvider — refresh', () => {
  it('sends redirect_uri and keeps a returned refresh and partner token', async () => {
    const fetchMock = stubFetch({
      json: {
        access_token: 'new-manager',
        authorization: 'new-partner',
        refresh_token: 'new-refresh',
        expires_in: 31536000,
      },
    });

    const tokens = await makeProvider().refreshAccessToken('old-refresh');

    expect(tokens).toMatchObject({
      accessToken: 'new-manager',
      refreshToken: 'new-refresh',
      authorizationToken: 'new-partner',
    });
    const form = new URLSearchParams(callOf(fetchMock).init.body as string);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('old-refresh');
    expect(form.get('redirect_uri')).toBe(
      'https://api.example.com/store/callback/zid',
    );
  });

  it('keeps the old refresh token and reports no partner token when none come back', async () => {
    stubFetch({ json: { access_token: 'new-manager', expires_in: 100 } });

    const tokens = await makeProvider().refreshAccessToken('old-refresh');

    expect(tokens.refreshToken).toBe('old-refresh');
    expect(tokens.authorizationToken).toBeUndefined();
  });
});

describe('ZidStoreProvider — listProducts', () => {
  it('pages with page/page_size and the product headers (Access-Token, Store-Id, Role)', async () => {
    const fetchMock = stubFetch({ json: ZID_PRODUCT_LIST_RESPONSE });

    const result = await makeProvider().listProducts(
      'zid-manager-token',
      '2',
      CONTEXT,
    );

    const { url, headers } = callOf(fetchMock);
    expect(url.origin + url.pathname).toBe('https://api.zid.sa/v1/products/');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(url.searchParams.has('per_page')).toBe(false);
    expect(headers).toMatchObject({
      Authorization: 'Bearer zid-partner-token',
      'Access-Token': 'zid-manager-token',
      'Store-Id': '3',
      Role: 'Manager',
    });
    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).toBe('3');
  });

  it('maps the documented product shape: {ar,en} names, categories[], image objects, payload currency', async () => {
    stubFetch({ json: ZID_PRODUCT_LIST_RESPONSE });

    const { products } = await makeProvider().listProducts(
      'tok',
      undefined,
      CONTEXT,
    );

    expect(products[0]).toEqual({
      externalId: 'a1477bb2-72ea-4be9-b2cf-093cefc721bb',
      name: 'voucher',
      nameAr: 'قسيمة',
      price: 100,
      currency: 'SAR',
      stock: 4,
      stockStatus: 'in_stock',
      imageUrl: undefined,
      sku: 'Z.1770805225810645',
      category: 'Electronics',
      metadata: {
        structure: 'standalone',
        url: 'https://osama.zid.store/products/قسيمة',
      },
    });
    expect(products[1]).toMatchObject({
      externalId: 'a497974d-1755-423a-b06c-e0578ba8c318',
      price: 257,
      stock: null,
      stockStatus: 'in_stock',
      metadata: { salePrice: 199 },
    });
    expect(products[1].imageUrl).toMatch(/-thumbnail-1000x1000\.png$/);
  });

  it('reports out_of_stock for a counted product at zero', async () => {
    stubFetch({
      json: {
        next: null,
        results: [
          { id: 'p-1', name: { en: 'Oud' }, quantity: 0, is_infinite: false },
        ],
      },
    });

    const result = await makeProvider().listProducts('tok', undefined, CONTEXT);

    expect(result.products[0]).toMatchObject({
      stock: 0,
      stockStatus: 'out_of_stock',
    });
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('refuses to call without the partner token (a connection made before migration 0066)', async () => {
    const fetchMock = stubFetch();

    await expect(
      makeProvider().listProducts('tok', undefined, { shop: '3' }),
    ).rejects.toThrow('reconnect the store');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ZidStoreProvider — rate limit (60 req/min per store)', () => {
  it('waits and retries on 429, honouring Retry-After', async () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const logger = { ...makeLogger(), warn } as unknown as AppLoggerService;
    const fetchMock = stubFetch(
      { status: 429, headers: { 'retry-after': '3' } },
      { json: ZID_PRODUCT_LIST_RESPONSE },
    );

    const pending = makeProvider({}, logger).listProducts(
      'tok',
      undefined,
      CONTEXT,
    );
    await jest.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ hasNextPage: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('429'),
      'ZidStoreProvider',
    );
  });

  it('gives up after three retries and fails on the 429', async () => {
    jest.useFakeTimers();
    const fetchMock = stubFetch(
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
    );

    const pending = makeProvider().listProducts('tok', undefined, CONTEXT);
    const assertion = expect(pending).rejects.toThrow(
      'Zid products list failed: 429',
    );
    await jest.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('backs off exponentially without Retry-After, capped at 30 s', () => {
    const noHeader = respond({ status: 429 }) as unknown as Response;
    expect(rateLimitDelayMs(noHeader, 0)).toBe(2_000);
    expect(rateLimitDelayMs(noHeader, 2)).toBe(8_000);
    expect(rateLimitDelayMs(noHeader, 10)).toBe(30_000);
  });
});

describe('ZidStoreProvider — order read-back', () => {
  it('reads one order from /managers/store/orders/{id}/view with both tokens', async () => {
    const fetchMock = stubFetch({
      json: {
        order: {
          ...ZID_ORDER_RESPONSE.order,
          order_status: { name: 'New', code: 'new' },
        },
      },
    });

    const order = await makeProvider().getOrder(
      'zid-manager-token',
      '68340124',
      CONTEXT,
    );

    const { url, headers } = callOf(fetchMock);
    expect(url.toString()).toBe(
      'https://api.zid.sa/v1/managers/store/orders/68340124/view',
    );
    expect(headers).toMatchObject({
      Authorization: 'Bearer zid-partner-token',
      'X-Manager-Token': 'zid-manager-token',
    });
    expect(order).toMatchObject({
      externalId: '68340124',
      status: 'pending',
      total: 6954.6399840237,
      currency: 'EGP',
      placedAt: new Date('2026-04-21T15:12:07Z'),
    });
  });

  it.each([
    ['new', 'pending'],
    ['preparing', 'processing'],
    ['ready', 'processing'],
    ['indelivery', 'processing'],
    ['inDelivery', 'processing'],
    ['delivered', 'completed'],
    ['cancelled', 'cancelled'],
    ['some_custom_status', 'unknown'],
  ])('maps order status %s to %s', async (code, status) => {
    stubFetch({
      json: {
        order: { ...ZID_ORDER_RESPONSE.order, order_status: { code } },
      },
    });

    const order = await makeProvider().getOrder('tok', '68340124', CONTEXT);

    expect(order?.status).toBe(status);
  });

  it('returns null without calling Zid for a reference that cannot be a Zid order id', async () => {
    const fetchMock = stubFetch();

    await expect(
      makeProvider().getOrder('tok', 'rEXuB20myr', CONTEXT),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on 404 and throws on other failures', async () => {
    stubFetch(
      { status: 404 },
      { status: 401, json: ZID_UNAUTHORIZED_RESPONSE },
    );
    const provider = makeProvider();

    await expect(provider.getOrder('tok', '1', CONTEXT)).resolves.toBeNull();
    await expect(provider.getOrder('tok', '1', CONTEXT)).rejects.toThrow(
      'Zid order read failed: 401',
    );
  });

  it('searches orders by the phone digits, newest first, with products', async () => {
    const fetchMock = stubFetch({ json: ZID_ORDER_LIST_RESPONSE });

    const orders = await makeProvider().listOrdersByCustomerPhone(
      'tok',
      '+966 59 155 5966',
      CONTEXT,
    );

    const { url } = callOf(fetchMock);
    expect(url.origin + url.pathname).toBe(
      'https://api.zid.sa/v1/managers/store/orders',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search_term: '966591555966',
      page: '1',
      per_page: '20',
      payload_type: 'default',
      order_by: 'created_at',
      sort_by: 'desc',
    });
    expect(orders).toEqual([
      {
        externalId: '64102971',
        orderNumber: '64102971',
        status: 'pending',
        placedAt: new Date('2026-01-28T21:20:01Z'),
        total: 100003.4494817,
        currency: 'SAR',
        customerPhone: '966591555966',
        trackingNumber: null,
        items: [{ name: 'sdfd', quantity: 1, price: 99999.999481699 }],
      },
    ]);
  });
});

describe('ZidStoreProvider — createOrder', () => {
  it('refuses before calling Zid: the drafts endpoint needs a shipping method, structured address and email we do not have', async () => {
    const fetchMock = stubFetch();

    await expect(makeProvider().createOrder()).rejects.toBeInstanceOf(
      ZidOrderInputError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ZidStoreProvider — webhook subscription', () => {
  const REGISTRATION = { storeId: '3', webhookSecret: 'per-connection-secret' };

  it('clears this app’s old subscriptions, then subscribes each event with Basic credentials to our route', async () => {
    const fetchMock = stubFetch(
      { json: {} },
      ...ZID_WEBHOOK_EVENTS.map(() => ({ json: ZID_CREATE_WEBHOOK_RESPONSE })),
    );

    await makeProvider().registerWebhooks(
      'zid-manager-token',
      CONTEXT,
      REGISTRATION,
    );

    const cleanup = callOf(fetchMock, 0);
    expect(cleanup.init.method).toBe('DELETE');
    expect(cleanup.url.toString()).toBe(
      'https://api.zid.sa/v1/managers/webhooks?original_id=2404',
    );

    const bodies = ZID_WEBHOOK_EVENTS.map((_, index) => {
      const call = callOf(fetchMock, index + 1);
      expect(call.init.method).toBe('POST');
      expect(call.url.toString()).toBe(
        'https://api.zid.sa/v1/managers/webhooks',
      );
      expect(call.headers).toMatchObject({
        Authorization: 'Bearer zid-partner-token',
        'X-Manager-Token': 'zid-manager-token',
        'Content-Type': 'application/json',
      });
      return JSON.parse(call.init.body as string) as Record<string, unknown>;
    });
    expect(bodies.map((body) => body.event)).toEqual([
      'order.create',
      'order.status.update',
      'product.create',
      'product.update',
      'product.delete',
    ]);
    for (const body of bodies) {
      expect(body).toEqual({
        event: body.event,
        target_url: 'https://api.example.com/store/webhook/zid/3',
        original_id: '2404',
        username: 'clarly',
        password: 'per-connection-secret',
      });
    }
  });

  it('subscribes the remaining events when one fails, then throws naming it', async () => {
    stubFetch(
      { status: 404 },
      { json: ZID_CREATE_WEBHOOK_RESPONSE },
      { status: 401, json: ZID_UNAUTHORIZED_RESPONSE },
      { json: ZID_CREATE_WEBHOOK_RESPONSE },
      { json: ZID_CREATE_WEBHOOK_RESPONSE },
      { json: ZID_CREATE_WEBHOOK_RESPONSE },
    );

    await expect(
      makeProvider().registerWebhooks('tok', CONTEXT, REGISTRATION),
    ).rejects.toThrow(
      'Zid webhook subscription failed for order.status.update (401: UNAUTHORIZED: Authentication credentials are missing, invalid, or expired.)',
    );
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it('throws without calling Zid when ZID_APP_ID is not set', async () => {
    const fetchMock = stubFetch();

    await expect(
      makeProvider({ zidAppId: '' }).registerWebhooks(
        'tok',
        CONTEXT,
        REGISTRATION,
      ),
    ).rejects.toThrow('ZID_APP_ID is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ZidStoreProvider — webhook verification and events', () => {
  const basic = (user: string, password: string) =>
    `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  it('verifies the Basic header against the per-connection secret in the Authorization header', () => {
    const provider = makeProvider();
    expect(provider.webhookSignatureHeader).toBe('authorization');
    expect(provider.resolveWebhookSecret('secret')).toBe('secret');
    expect(provider.resolveWebhookSecret(null)).toBeNull();
    expect(provider.resolveWebhookSecret('')).toBeNull();

    const body = Buffer.from('{}');
    expect(
      provider.verifyWebhookSignature(
        body,
        basic('clarly', 'secret'),
        'secret',
      ),
    ).toBe(true);
    expect(
      provider.verifyWebhookSignature(body, basic('clarly', 'other'), 'secret'),
    ).toBe(false);
    expect(
      provider.verifyWebhookSignature(body, basic('admin', 'secret'), 'secret'),
    ).toBe(false);
    expect(provider.verifyWebhookSignature(body, 'Basic', 'secret')).toBe(
      false,
    );
  });

  it.each([
    ['order.create', 'order_created', '68340124'],
    ['order.status.update', 'order_updated', '68340124'],
    ['order.payment_status.update', 'order_updated', '68340124'],
    ['product.create', 'product_updated', '68340124'],
    ['product.update', 'product_updated', '68340124'],
    ['product.publish', 'product_updated', '68340124'],
    ['product.delete', 'product_updated', '68340124'],
    ['customer.login', 'unknown', ''],
  ])('normalizes %s to %s', (event, eventType, externalId) => {
    const normalized = makeProvider().normalizeWebhookEvent(
      { event, data: { id: 68340124 } },
      '3',
    );
    expect(normalized).toMatchObject({ eventType, externalId, storeId: '3' });
  });

  it('accepts `event_name` and a top-level resource (the envelope is undocumented)', () => {
    expect(
      makeProvider().normalizeWebhookEvent(
        { event_name: 'product.update', id: 'p-uuid' },
        '3',
      ),
    ).toMatchObject({ eventType: 'product_updated', externalId: 'p-uuid' });
  });

  it('maps the App Market uninstall event to app_uninstalled', () => {
    expect(
      makeProvider().normalizeWebhookEvent(
        {
          app_id: 1292,
          store_id: 3,
          event_name: 'app.market.application.uninstall',
          status: 'uninstall',
        },
        '3',
      ),
    ).toMatchObject({ eventType: 'app_uninstalled', externalId: '' });
  });

  it('ignores a body with no event name, and the old invented names normalize to unknown', () => {
    const provider = makeProvider();
    expect(provider.normalizeWebhookEvent({ data: { id: 1 } }, '3')).toBeNull();
    for (const event of [
      'order.created',
      'product.updated',
      'product.stock.updated',
      'stock.updated',
    ]) {
      expect(
        provider.normalizeWebhookEvent({ event, data: { id: 1 } }, '3')
          ?.eventType,
      ).toBe('unknown');
    }
  });

  it('keys events by name, resource id and updated_at; null (body hash) without them', () => {
    const provider = makeProvider();
    expect(
      provider.extractEventId({
        event: 'order.status.update',
        data: { id: 68340124, updated_at: '2026-04-21 15:12:23' },
      }),
    ).toBe('order.status.update:68340124:2026-04-21 15:12:23');
    expect(
      provider.extractEventId({ event: 'order.create', data: { id: 1 } }),
    ).toBeNull();
    expect(
      provider.extractEventId({
        event: 'order.create',
        data: { id: { nested: true }, updated_at: 'x' },
      }),
    ).toBeNull();
    expect(provider.extractEventId('not an object')).toBeNull();
  });
});
