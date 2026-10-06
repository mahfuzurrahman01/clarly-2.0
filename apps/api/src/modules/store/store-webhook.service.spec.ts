// F24: webhook authentication + idempotency regression tests.
//
// Before the retroactive review these two properties did not exist: the
// per-connection `webhook_secret` was never populated (so the verify branch
// never ran), the header checked was an invented one no provider sends, and
// nothing wrote to `store_webhook_events` — every provider retry re-applied
// the same stock mutation.
import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { AppConfigService, AppLoggerService } from '../core';
import type { CatalogService } from '../catalog/catalog.service';
import { SallaStoreProvider } from './ports/salla-store.provider';
import { ZidStoreProvider } from './ports/zid-store.provider';
import { ShopifyStoreProvider } from './ports/shopify-store.provider';
import { WooCommerceStoreProvider } from './ports/woocommerce-store.provider';
import { NoopStoreProvider } from './ports/noop-store.provider';
import { StoreProviderRegistry } from './store-provider.registry';
import { StoreWebhookService } from './store-webhook.service';
import type {
  StoreConnectionService,
  StoreConnection,
} from './store-connection.service';
import type { StoreWebhookEventStore } from './store-webhook-event.store';
import type { StoreSyncService } from './store-sync.service';

const WEBHOOK_SECRET = 'whsec_per_connection';
const SHOPIFY_APP_SECRET = 'shopify_app_api_secret';

function makeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function makeConfig(): AppConfigService {
  return {
    sallaClientId: 'salla-client',
    sallaClientSecret: 'salla-secret',
    sallaRedirectUri: 'https://api.example.com/store/callback/salla',
    zidClientId: 'zid-client',
    zidClientSecret: 'zid-secret',
    zidRedirectUri: 'https://api.example.com/store/callback/zid',
    shopifyClientId: 'shopify-client',
    shopifyClientSecret: SHOPIFY_APP_SECRET,
    shopifyShopDomain: 'acme.myshopify.com',
    apiPublicBaseUrl: 'https://api.example.com',
  } as unknown as AppConfigService;
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
    accessToken: 'access',
    refreshToken: null,
    authorizationToken: null,
    tokenExpiresAt: null,
    webhookSecret: WEBHOOK_SECRET,
    isActive: true,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** In-memory stand-in for the `store_webhook_events` unique-key claim. */
function makeEventStore() {
  const claimed = new Map<string, string>();
  const statuses = new Map<string, string>();
  let counter = 0;
  const store = {
    claim: jest.fn(
      async (event: { provider: string; storeId: string; eventId: string }) => {
        const key = `${event.provider}:${event.storeId}:${event.eventId}`;
        if (claimed.has(key)) return null;
        const id = `evt-${++counter}`;
        claimed.set(key, id);
        return id;
      },
    ),
    markStatus: jest.fn(async (id: string, status: string) => {
      statuses.set(id, status);
    }),
  };
  return {
    store: store as unknown as StoreWebhookEventStore,
    statuses,
    raw: store,
  };
}

function makeHarness(connection: StoreConnection | null = makeConnection()) {
  const config = makeConfig();
  const registry = new StoreProviderRegistry(
    new SallaStoreProvider(config),
    new ZidStoreProvider(config, makeLogger()),
    new ShopifyStoreProvider(config, makeLogger()),
    new WooCommerceStoreProvider(config),
    new NoopStoreProvider(makeLogger()),
  );
  const markDisconnected = jest.fn().mockResolvedValue(true);
  const connectionService = {
    findByProviderAndStoreId: jest.fn().mockResolvedValue(connection),
    markDisconnected,
  } as unknown as StoreConnectionService;
  const syncConnection = jest.fn().mockResolvedValue({ synced: 1, errors: 0 });
  const syncService = { syncConnection } as unknown as StoreSyncService;
  const updateStock = jest.fn().mockResolvedValue(true);
  const catalogService = { updateStock } as unknown as CatalogService;
  const events = makeEventStore();

  const service = new StoreWebhookService(
    connectionService,
    registry,
    events.store,
    catalogService,
    syncService,
    makeLogger(),
  );

  return {
    service,
    connectionService,
    catalogService,
    events,
    updateStock,
    syncConnection,
    markDisconnected,
  };
}

function sallaBody(eventId = 'evt-100', stock: number | null = 4): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: 'stock.updated',
      event_id: eventId,
      data: { id: 'SKU-1', stock },
    }),
  );
}

function sign(
  body: Buffer,
  secret: string,
  encoding: 'hex' | 'base64' = 'hex',
): string {
  return createHmac('sha256', secret).update(body).digest(encoding);
}

describe('StoreWebhookService', () => {
  describe('signature verification', () => {
    it('accepts a correctly signed Salla webhook and applies it', async () => {
      const { service, catalogService } = makeHarness();
      const body = sallaBody();

      const outcome = await service.handleWebhook('salla', 'store-1', body, {
        'x-salla-signature': sign(body, WEBHOOK_SECRET),
      });

      expect(outcome).toEqual({ processed: true, event: 'stock_changed' });
      expect(catalogService.updateStock).toHaveBeenCalledWith(
        'tenant-a',
        'SKU-1',
        4,
      );
    });

    it('applies a null stock as untracked, not as 0 (out of stock)', async () => {
      const { service, catalogService } = makeHarness();
      const { updateStock } = catalogService as unknown as {
        updateStock: jest.Mock;
      };
      const body = sallaBody('evt-null', null);

      await service.handleWebhook('salla', 'store-1', body, {
        'x-salla-signature': sign(body, WEBHOOK_SECRET),
      });

      expect(updateStock).toHaveBeenCalledWith('tenant-a', 'SKU-1', null);
    });

    it('ignores a stock event that carries no stock field at all', async () => {
      const { service, catalogService } = makeHarness();
      const { updateStock } = catalogService as unknown as {
        updateStock: jest.Mock;
      };
      const body = Buffer.from(
        JSON.stringify({
          event: 'stock.updated',
          event_id: 'evt-none',
          data: { id: 'SKU-1' },
        }),
      );

      await service.handleWebhook('salla', 'store-1', body, {
        'x-salla-signature': sign(body, WEBHOOK_SECRET),
      });

      expect(updateStock).not.toHaveBeenCalled();
    });

    it('rejects a forged signature without touching the catalog', async () => {
      const { service, catalogService } = makeHarness();
      const body = sallaBody();

      await expect(
        service.handleWebhook('salla', 'store-1', body, {
          'x-salla-signature': sign(body, 'attacker-secret'),
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(catalogService.updateStock).not.toHaveBeenCalled();
    });

    it('rejects a short/garbage signature instead of throwing on length mismatch', async () => {
      const { service } = makeHarness();
      const body = sallaBody();

      await expect(
        service.handleWebhook('salla', 'store-1', body, {
          'x-salla-signature': 'xx',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a body tampered with after signing', async () => {
      const { service } = makeHarness();
      const signature = sign(sallaBody('evt-100', 4), WEBHOOK_SECRET);

      await expect(
        service.handleWebhook('salla', 'store-1', sallaBody('evt-100', 9999), {
          'x-salla-signature': signature,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the signature arrives in some other header', async () => {
      const { service } = makeHarness();
      const body = sallaBody();

      await expect(
        service.handleWebhook('salla', 'store-1', body, {
          // the invented header the first cut read
          'x-webhook-signature': sign(body, WEBHOOK_SECRET),
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the connection has no webhook secret (no unverified processing)', async () => {
      const { service, catalogService } = makeHarness(
        makeConnection({ webhookSecret: null }),
      );
      const body = sallaBody();

      await expect(
        service.handleWebhook('salla', 'store-1', body, {
          'x-salla-signature': sign(body, WEBHOOK_SECRET),
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(catalogService.updateStock).not.toHaveBeenCalled();
    });

    it('rejects an unknown (provider, store) without revealing that it is unknown', async () => {
      const { service } = makeHarness(null);
      const body = sallaBody();

      await expect(
        service.handleWebhook('salla', 'ghost-store', body, {
          'x-salla-signature': sign(body, WEBHOOK_SECRET),
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    describe('Zid Basic-auth deliveries', () => {
      const zidConnection = () =>
        makeConnection({ provider: 'zid', storeId: '3' });
      const basic = (password: string, username = 'clarly') =>
        `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      const zidBody = (event: string, data: Record<string, unknown>) =>
        Buffer.from(JSON.stringify({ event, data }));

      it('accepts the Basic credentials Zid was subscribed with', async () => {
        const { service } = makeHarness(zidConnection());
        const body = zidBody('product.update', {
          id: 'a1477bb2-72ea-4be9-b2cf-093cefc721bb',
          updated_at: '2026-02-11T10:21:46.786699Z',
        });

        await expect(
          service.handleWebhook('zid', '3', body, {
            authorization: basic(WEBHOOK_SECRET),
          }),
        ).resolves.toEqual({ processed: false, event: 'product_updated' });
      });

      it('rejects a wrong password, a wrong username, and no Authorization header', async () => {
        const { service, events } = makeHarness(zidConnection());
        const body = zidBody('order.create', { id: 68340124 });

        for (const headers of [
          { authorization: basic('not-the-secret') },
          { authorization: basic(WEBHOOK_SECRET, 'someone-else') },
          { authorization: 'Basic' },
          {},
        ]) {
          await expect(
            service.handleWebhook('zid', '3', body, headers),
          ).rejects.toBeInstanceOf(UnauthorizedException);
        }
        expect(events.raw.claim).not.toHaveBeenCalled();
      });

      it('rejects the HMAC header the old adapter expected (Zid does not sign bodies)', async () => {
        const { service } = makeHarness(zidConnection());
        const body = zidBody('order.create', { id: 68340124 });

        await expect(
          service.handleWebhook('zid', '3', body, {
            'x-zid-signature': sign(body, WEBHOOK_SECRET),
          }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      });

      it('records successive status changes of one order as distinct events', async () => {
        const { service, events } = makeHarness(zidConnection());
        const headers = { authorization: basic(WEBHOOK_SECRET) };
        const update = (updatedAt: string, code: string) =>
          zidBody('order.status.update', {
            id: 68340124,
            updated_at: updatedAt,
            order_status: { code },
          });

        await expect(
          service.handleWebhook(
            'zid',
            '3',
            update('2026-04-21 15:12:23', 'preparing'),
            headers,
          ),
        ).resolves.toEqual({ processed: false, event: 'order_updated' });
        await expect(
          service.handleWebhook(
            'zid',
            '3',
            update('2026-04-21 16:00:00', 'ready'),
            headers,
          ),
        ).resolves.toEqual({ processed: false, event: 'order_updated' });
        await expect(
          service.handleWebhook(
            'zid',
            '3',
            update('2026-04-21 16:00:00', 'ready'),
            headers,
          ),
        ).resolves.toEqual({
          processed: false,
          duplicate: true,
          event: 'order_updated',
        });
        expect(events.raw.claim).toHaveBeenCalledWith(
          expect.objectContaining({
            eventId: 'order.status.update:68340124:2026-04-21 16:00:00',
          }),
        );
      });
    });

    it('verifies Shopify with the app secret, base64, and its topic header', async () => {
      const { service } = makeHarness(
        makeConnection({
          provider: 'shopify',
          storeId: 'acme.myshopify.com',
          webhookSecret: null,
        }),
      );
      const body = Buffer.from(JSON.stringify({ id: 987, title: 'Thing' }));

      const outcome = await service.handleWebhook(
        'shopify',
        'acme.myshopify.com',
        body,
        {
          'x-shopify-hmac-sha256': sign(body, SHOPIFY_APP_SECRET, 'base64'),
          'x-shopify-topic': 'products/update',
          'x-shopify-webhook-id': 'wh-1',
        },
      );

      expect(outcome).toEqual({ processed: false, event: 'product_updated' });
    });

    it('rejects a Shopify webhook signed with the hex encoding Shopify does not use', async () => {
      const { service } = makeHarness(
        makeConnection({ provider: 'shopify', storeId: 'acme.myshopify.com' }),
      );
      const body = Buffer.from(JSON.stringify({ id: 987 }));

      await expect(
        service.handleWebhook('shopify', 'acme.myshopify.com', body, {
          'x-shopify-hmac-sha256': sign(body, SHOPIFY_APP_SECRET, 'hex'),
          'x-shopify-topic': 'products/update',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    describe('Shopify inventory and uninstall topics', () => {
      const SHOP = 'acme.myshopify.com';
      const shopifyConnection = () =>
        makeConnection({ provider: 'shopify', storeId: SHOP });
      const deliver = (
        service: StoreWebhookService,
        topic: string,
        payload: Record<string, unknown>,
        webhookId: string,
      ) => {
        const body = Buffer.from(JSON.stringify(payload));
        return service.handleWebhook('shopify', SHOP, body, {
          'x-shopify-hmac-sha256': sign(body, SHOPIFY_APP_SECRET, 'base64'),
          'x-shopify-topic': topic,
          'x-shopify-webhook-id': webhookId,
        });
      };

      it('re-syncs the connection on inventory_levels/update instead of writing a per-location count against an inventory item id', async () => {
        const { service, updateStock, syncConnection } =
          makeHarness(shopifyConnection());

        const outcome = await deliver(
          service,
          'inventory_levels/update',
          { inventory_item_id: 271878346596884, location_id: 1, available: 3 },
          'wh-inv-1',
        );

        expect(outcome).toEqual({
          processed: true,
          event: 'inventory_changed',
        });
        expect(updateStock).not.toHaveBeenCalled();
        expect(syncConnection).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'conn-1', provider: 'shopify' }),
        );
      });

      it('starts one re-sync for a burst of inventory events while the first is still running', async () => {
        const { service, syncConnection } = makeHarness(shopifyConnection());
        let finish: () => void = () => undefined;
        syncConnection.mockReturnValueOnce(
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        );

        const first = await deliver(
          service,
          'inventory_levels/update',
          { inventory_item_id: 1, available: 3 },
          'wh-inv-a',
        );
        const second = await deliver(
          service,
          'inventory_levels/update',
          { inventory_item_id: 1, available: 2 },
          'wh-inv-b',
        );
        finish();

        expect(first.processed).toBe(true);
        expect(second.processed).toBe(false);
        expect(syncConnection).toHaveBeenCalledTimes(1);
      });

      it('marks the connection disconnected on app/uninstalled', async () => {
        const { service, markDisconnected } = makeHarness(shopifyConnection());

        const outcome = await deliver(
          service,
          'app/uninstalled',
          { id: 1, myshopify_domain: SHOP },
          'wh-uninstall-1',
        );

        expect(outcome).toEqual({ processed: true, event: 'app_uninstalled' });
        expect(markDisconnected).toHaveBeenCalledWith('tenant-a', 'conn-1');
      });
    });

    it('rejects an empty body', async () => {
      const { service } = makeHarness();
      await expect(
        service.handleWebhook('salla', 'store-1', undefined, {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('idempotency', () => {
    it('processes a redelivered event exactly once', async () => {
      const { service, catalogService, events } = makeHarness();
      const body = sallaBody('evt-dup');
      const headers = { 'x-salla-signature': sign(body, WEBHOOK_SECRET) };

      const first = await service.handleWebhook(
        'salla',
        'store-1',
        body,
        headers,
      );
      const second = await service.handleWebhook(
        'salla',
        'store-1',
        body,
        headers,
      );

      expect(first.processed).toBe(true);
      expect(second).toEqual({
        processed: false,
        duplicate: true,
        event: 'stock_changed',
      });
      expect(catalogService.updateStock).toHaveBeenCalledTimes(1);
      expect(events.raw.claim).toHaveBeenCalledTimes(2);
    });

    it('treats a different event id on the same store as a new event', async () => {
      const { service, catalogService } = makeHarness();
      for (const id of ['evt-1', 'evt-2']) {
        const body = sallaBody(id);
        await service.handleWebhook('salla', 'store-1', body, {
          'x-salla-signature': sign(body, WEBHOOK_SECRET),
        });
      }
      expect(catalogService.updateStock).toHaveBeenCalledTimes(2);
    });

    it('falls back to a body hash when the provider sends no event id', async () => {
      const { service, catalogService } = makeHarness();
      const body = Buffer.from(
        JSON.stringify({ event: 'stock.updated', data: { stock: 2 } }),
      );
      const headers = { 'x-salla-signature': sign(body, WEBHOOK_SECRET) };

      await service.handleWebhook('salla', 'store-1', body, headers);
      const second = await service.handleWebhook(
        'salla',
        'store-1',
        body,
        headers,
      );

      expect(second.duplicate).toBe(true);
      // No externalId in this payload, so nothing was applied either time.
      expect(catalogService.updateStock).not.toHaveBeenCalled();
    });

    it('marks a claimed event failed when processing throws, so it can be investigated', async () => {
      const { service, catalogService, events } = makeHarness();
      (catalogService.updateStock as jest.Mock).mockRejectedValueOnce(
        new Error('db down'),
      );
      const body = sallaBody('evt-boom');

      await expect(
        service.handleWebhook('salla', 'store-1', body, {
          'x-salla-signature': sign(body, WEBHOOK_SECRET),
        }),
      ).rejects.toThrow('db down');
      expect(events.statuses.get('evt-1')).toBe('failed');
    });
  });
});
