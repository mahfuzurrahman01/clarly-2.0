// F24: the callback must take its tenant from the signed state and nothing
// else, and the refresh path must use the refresh grant.
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfigService, AppLoggerService } from '../core';
import { StoreOAuthService } from './store-oauth.service';
import {
  InvalidStoreConnectStateError,
  StoreOAuthStateService,
} from './store-oauth-state.service';
import type {
  StoreConnection,
  StoreConnectionService,
} from './store-connection.service';
import type { StoreProviderRegistry } from './store-provider.registry';
import type { StoreProvider } from './ports/store-provider.port';

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
    storeName: 'A Store',
    storeUrl: null,
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    authorizationToken: null,
    tokenExpiresAt: null,
    webhookSecret: null,
    isActive: true,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    set: jest.fn(
      async (
        key: string,
        value: string,
        _ex: 'EX',
        _ttl: number,
        _nx: 'NX',
      ) => {
        if (store.has(key)) {
          return null;
        }
        store.set(key, value);
        return 'OK';
      },
    ),
  };
}

function makeHarness(
  options: { providerConfigured?: boolean; boundShop?: string } = {},
) {
  const stateService = new StoreOAuthStateService(
    {
      whatsappConnectStateSecret: 'state-secret',
    } as unknown as AppConfigService,
    makeFakeRedis() as never,
  );

  const isStoreProviderConfigured = jest
    .fn()
    .mockReturnValue(options.providerConfigured ?? true);
  const config = {
    isStoreProviderConfigured,
  } as unknown as AppConfigService;

  const exchangeCode = jest.fn().mockResolvedValue({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    storeId: 'store-1',
    storeName: 'A Store',
    storeUrl: 'https://a.example.com',
  });
  const refreshAccessToken = jest.fn().mockResolvedValue({
    accessToken: 'refreshed-access',
    refreshToken: 'refreshed-refresh',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  });
  const getOAuthAuthorizeUrl = jest
    .fn()
    .mockReturnValue('https://provider/authorize');
  const connectBinding = jest
    .fn()
    .mockReturnValue(options.boundShop ? { shop: options.boundShop } : {});
  const verifyCallbackSignature = jest.fn().mockReturnValue(true);
  const registerWebhooks = jest.fn().mockResolvedValue(undefined);
  const adapter = {
    exchangeCode,
    refreshAccessToken,
    getOAuthAuthorizeUrl,
    connectBinding,
    verifyCallbackSignature,
    registerWebhooks,
  } as unknown as StoreProvider;

  const createConnection = jest.fn(async (input: { tenantId: string }) =>
    makeConnection({ tenantId: input.tenantId }),
  );
  const updateTokens = jest
    .fn<Promise<void>, [string, string, Record<string, unknown>]>()
    .mockResolvedValue(undefined);
  const connectionService = {
    create: createConnection,
    updateTokens,
    markDisconnected: jest.fn().mockResolvedValue(true),
  } as unknown as StoreConnectionService;

  const registry = {
    forProvider: jest.fn().mockReturnValue(adapter),
  } as unknown as StoreProviderRegistry;

  const logError = jest.fn();
  const logger = {
    ...makeLogger(),
    error: logError,
  } as unknown as AppLoggerService;
  const service = new StoreOAuthService(
    connectionService,
    stateService,
    registry,
    config,
    logger,
  );

  return {
    service,
    stateService,
    connectionService,
    exchangeCode,
    refreshAccessToken,
    getOAuthAuthorizeUrl,
    isStoreProviderConfigured,
    verifyCallbackSignature,
    registerWebhooks,
    logError,
    createConnection,
    updateTokens,
  };
}

describe('StoreOAuthService', () => {
  describe('Shopify shop binding', () => {
    const SHOP = 'a-shop.myshopify.com';

    it('exchanges the code against the shop sealed at initiate time', async () => {
      const { service, exchangeCode, getOAuthAuthorizeUrl } = makeHarness({
        boundShop: SHOP,
      });

      const { state } = service.initiateOAuth('tenant-a', 'shopify', {
        shop: 'A-Shop.myshopify.com',
      });
      expect(getOAuthAuthorizeUrl).toHaveBeenCalledWith(
        state,
        expect.objectContaining({ shop: SHOP }),
      );

      await service.handleCallback('shopify', 'code', state, undefined);

      expect(exchangeCode).toHaveBeenCalledWith(
        'code',
        expect.objectContaining({ shop: SHOP }),
      );
    });

    it('rejects a callback whose ?shop= disagrees with the sealed shop', async () => {
      const { service, exchangeCode, createConnection } = makeHarness({
        boundShop: SHOP,
      });
      const { state } = service.initiateOAuth('tenant-a', 'shopify', {
        shop: SHOP,
      });

      await expect(
        service.handleCallback('shopify', 'code', state, {
          shop: 'attacker.myshopify.com',
        }),
      ).rejects.toBeInstanceOf(InvalidStoreConnectStateError);
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(createConnection).not.toHaveBeenCalled();
    });
  });

  describe('callback signature and webhook registration', () => {
    const SHOP = 'a-shop.myshopify.com';

    it('passes the full callback query to the adapter and writes nothing on a bad signature', async () => {
      const {
        service,
        exchangeCode,
        createConnection,
        verifyCallbackSignature,
      } = makeHarness({ boundShop: SHOP });
      verifyCallbackSignature.mockReturnValueOnce(false);
      const { state } = service.initiateOAuth('tenant-a', 'shopify', {
        shop: SHOP,
      });
      const query = { code: 'code', state, shop: SHOP, hmac: 'bad', host: 'x' };

      await expect(
        service.handleCallback('shopify', 'code', state, { shop: SHOP }, query),
      ).rejects.toBeInstanceOf(InvalidStoreConnectStateError);
      expect(verifyCallbackSignature).toHaveBeenCalledWith(query);
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(createConnection).not.toHaveBeenCalled();
    });

    it('registers webhooks with the new token and the sealed shop after the connection is written', async () => {
      const { service, createConnection, registerWebhooks } = makeHarness({
        boundShop: SHOP,
      });
      const { state } = service.initiateOAuth('tenant-a', 'shopify', {
        shop: SHOP,
      });

      await service.handleCallback('shopify', 'code', state, { shop: SHOP });

      expect(registerWebhooks).toHaveBeenCalledWith(
        'new-access',
        expect.objectContaining({ shop: SHOP }),
        expect.objectContaining({ storeId: 'store-1' }),
      );
      const createOrder = createConnection.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(
        registerWebhooks.mock.invocationCallOrder[0],
      );
    });

    it('keeps the connection when webhook registration fails, and logs it', async () => {
      const { service, registerWebhooks, logError } = makeHarness({
        boundShop: SHOP,
      });
      registerWebhooks.mockRejectedValueOnce(new Error('Shopify down'));
      const { state } = service.initiateOAuth('tenant-a', 'shopify', {
        shop: SHOP,
      });

      await expect(
        service.handleCallback('shopify', 'code', state, { shop: SHOP }),
      ).resolves.toMatchObject({
        tenantId: 'tenant-a',
        webhooksRegistered: false,
      });
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Shopify down'),
        'StoreOAuthService',
      );
    });

    it('reports webhooksRegistered when registration succeeds', async () => {
      const { service, stateService } = makeHarness();

      await expect(
        service.handleCallback(
          'zid',
          'code',
          stateService.sign('tenant-a', 'zid'),
          {},
        ),
      ).resolves.toMatchObject({ webhooksRegistered: true });
    });

    it("stores Zid's partner token and subscribes with it and the minted webhook secret", async () => {
      const {
        service,
        stateService,
        exchangeCode,
        createConnection,
        registerWebhooks,
      } = makeHarness();
      exchangeCode.mockResolvedValueOnce({
        accessToken: 'manager-token',
        authorizationToken: 'partner-token',
        refreshToken: 'zid-refresh',
        storeId: '3',
        storeName: 'Zid Store',
      });

      await service.handleCallback(
        'zid',
        'code',
        stateService.sign('tenant-a', 'zid'),
        {},
      );

      const input = createConnection.mock.calls[0][0] as {
        authorizationToken?: string;
        webhookSecret?: string;
      };
      expect(input.authorizationToken).toBe('partner-token');
      expect(registerWebhooks).toHaveBeenCalledWith(
        'manager-token',
        expect.objectContaining({ authorizationToken: 'partner-token' }),
        { storeId: '3', webhookSecret: input.webhookSecret },
      );
    });
  });

  it('starts the connect flow for a provider this deployment has credentials for', () => {
    const { service, isStoreProviderConfigured } = makeHarness();

    const { authorizeUrl, state } = service.initiateOAuth('tenant-a', 'salla');

    expect(isStoreProviderConfigured).toHaveBeenCalledWith('salla');
    expect(authorizeUrl).toBe('https://provider/authorize');
    expect(state).not.toHaveLength(0);
  });

  it('refuses to mint an authorize URL for a provider with no configured credentials', () => {
    // Without this the merchant is redirected to the provider with an empty
    // client_id and lands on the provider's own error page, where neither
    // they nor an operator can see what is actually wrong.
    const { service, getOAuthAuthorizeUrl } = makeHarness({
      providerConfigured: false,
    });

    expect(() => service.initiateOAuth('tenant-a', 'zid')).toThrow(
      ServiceUnavailableException,
    );
    expect(getOAuthAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('derives the tenant from the signed state, not from anything else in the request', async () => {
    const { service, stateService, connectionService } = makeHarness();
    const state = stateService.sign('tenant-a', 'salla');

    const result = await service.handleCallback(
      'salla',
      'auth-code',
      state,
      {},
    );

    expect(result.tenantId).toBe('tenant-a');
    expect(connectionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', provider: 'salla' }),
    );
  });

  it('writes nothing when the state is forged or missing', async () => {
    const { service, connectionService, exchangeCode } = makeHarness();

    await expect(
      service.handleCallback('salla', 'auth-code', 'not-a-jwt', {}),
    ).rejects.toBeInstanceOf(InvalidStoreConnectStateError);
    await expect(
      service.handleCallback('salla', 'auth-code', undefined, {}),
    ).rejects.toBeInstanceOf(InvalidStoreConnectStateError);

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(connectionService.create).not.toHaveBeenCalled();
  });

  it('mints a webhook secret at connect time so the webhook path has something to verify', async () => {
    const { service, stateService, connectionService } = makeHarness();

    await service.handleCallback(
      'salla',
      'auth-code',
      stateService.sign('tenant-a', 'salla'),
      {},
    );

    const input = (connectionService.create as jest.Mock).mock.calls[0][0];
    expect(input.webhookSecret).toHaveLength(64);
  });

  it('returns the stored token when it is not near expiry', async () => {
    const { service, refreshAccessToken } = makeHarness();
    const connection = makeConnection({
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    });

    await expect(service.ensureCredentials(connection)).resolves.toEqual({
      accessToken: 'stored-access',
      authorizationToken: undefined,
    });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('uses the refresh grant and persists the rotated token when expired', async () => {
    const { service, refreshAccessToken, connectionService } = makeHarness();
    const connection = makeConnection({
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(service.ensureCredentials(connection)).resolves.toMatchObject({
      accessToken: 'refreshed-access',
    });
    expect(refreshAccessToken).toHaveBeenCalledWith('stored-refresh');
    expect(connectionService.updateTokens).toHaveBeenCalledWith(
      'tenant-a',
      'conn-1',
      {
        accessToken: 'refreshed-access',
        refreshToken: 'refreshed-refresh',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      },
    );
  });

  it('keeps the stored token for providers with no refresh grant (Shopify)', async () => {
    const { service, refreshAccessToken } = makeHarness();
    refreshAccessToken.mockResolvedValueOnce(null);
    const connection = makeConnection({
      provider: 'shopify',
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(service.ensureCredentials(connection)).resolves.toMatchObject({
      accessToken: 'stored-access',
    });
  });

  it("returns Zid's stored partner token with the access token", async () => {
    const { service } = makeHarness();
    const connection = makeConnection({
      provider: 'zid',
      authorizationToken: 'stored-partner',
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    });

    await expect(service.ensureCredentials(connection)).resolves.toEqual({
      accessToken: 'stored-access',
      authorizationToken: 'stored-partner',
    });
  });

  it('keeps the stored Zid partner token when a refresh returns none, and persists a rotated one', async () => {
    const { service, refreshAccessToken, updateTokens } = makeHarness();
    const connection = makeConnection({
      provider: 'zid',
      authorizationToken: 'stored-partner',
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(service.ensureCredentials(connection)).resolves.toEqual({
      accessToken: 'refreshed-access',
      authorizationToken: 'stored-partner',
    });
    expect(updateTokens.mock.calls[0][2]).not.toHaveProperty(
      'authorizationToken',
    );

    refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'refreshed-access-2',
      authorizationToken: 'rotated-partner',
    });
    await expect(service.ensureCredentials(connection)).resolves.toEqual({
      accessToken: 'refreshed-access-2',
      authorizationToken: 'rotated-partner',
    });
    expect(updateTokens.mock.calls[1][2]).toMatchObject({
      authorizationToken: 'rotated-partner',
    });
  });

  it('reports a not-found (never an existence oracle) when disconnect matches no row for this tenant', async () => {
    const { service, connectionService } = makeHarness();
    (connectionService.markDisconnected as jest.Mock).mockResolvedValueOnce(
      false,
    );

    await expect(
      service.disconnect('tenant-b', 'conn-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
