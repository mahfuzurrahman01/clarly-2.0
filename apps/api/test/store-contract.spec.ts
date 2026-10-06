// F24 (Store Integrations) Contract: `pnpm --filter api test:store-contract`.
//
// Mirrors the F26 courier contract suite (test/courier-contract.spec.ts): it
// pins each store connector's response CONTRACT — the field names and status
// vocabulary each adapter is written against — against recorded fixtures.
// A vendor renaming or adding a field becomes a failing test here rather than
// a silent `unknown`/empty value shown to a customer or fed to the agent.
//
// Kept out of the default suite (its own jest project, like
// `test:courier-contract`) for the same reason: the unit specs
// (woocommerce-store.provider.spec.ts) ask "is the adapter correct", this
// asks "is the vendor still doing what we recorded".
//
// STATUS TODAY: every fixture is transcribed from published documentation.
// No connector in this repo has ever been called against a live store.
//
// Primary method under test: `getOrder()` (F24's order read-back item). It is
// the method every provider funnels through a shared status-normalization
// step — `normalizeOrderStatus()` for Salla/WooCommerce, `zidOrderStatus()`
// for Zid, `shopifyOrderStatus()` for Shopify — which is exactly the "vendor renames a
// status, it degrades silently to `unknown`" surface the GULF_PARITY_PLAN
// Phase 6 follow-up calls out for store connectors.
import type { AppConfigService } from '../src/modules/core/config/app-config.service';
import type { AppLoggerService } from '../src/modules/core';
import { SallaStoreProvider } from '../src/modules/store/ports/salla-store.provider';
import { ZidStoreProvider } from '../src/modules/store/ports/zid-store.provider';
import { ShopifyStoreProvider } from '../src/modules/store/ports/shopify-store.provider';
import { WooCommerceStoreProvider } from '../src/modules/store/ports/woocommerce-store.provider';
import type {
  StoreOAuthCallbackContext,
  StoreOrderStatus,
  StoreOrderSummary,
} from '../src/modules/store/ports/store-provider.port';
import {
  SALLA_ORDER_RESPONSE,
  ZID_ORDER_RESPONSE,
  WOOCOMMERCE_ORDER_RESPONSE,
  SHOPIFY_ORDER_RESPONSE,
} from '../src/modules/store/ports/__fixtures__/store-responses';

/**
 * The platform's normalized order-status vocabulary, kept in lockstep with
 * the `StoreOrderStatus` union in store-provider.port.ts via `satisfies`
 * rather than hand-duplicated as a plain array: unlike F26's courier
 * `ShipmentStatus` (backed by the `shipments` table's `SHIPMENT_STATUSES`
 * CHECK constraint), `StoreOrderStatus` is never persisted — `StoreOrderSummary`
 * is a live, un-cached read-back (see grep: no `StoreOrderStatus` reference
 * outside the store module), so there is no Drizzle schema CHECK constraint
 * to import here. `satisfies readonly StoreOrderStatus[]` makes this array a
 * compile error, not a silent drift, if the union in the port ever changes
 * without this file being updated.
 */
const STORE_ORDER_STATUSES = [
  'pending',
  'processing',
  'on_hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
  'unknown',
] as const satisfies readonly StoreOrderStatus[];

/** A phrase that must never survive into a normalized field — the prompt-injection defense check. */
const INJECTION_MARKER = 'IGNORE PREVIOUS INSTRUCTIONS';

function serveOnce(body: unknown): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

function fakeConfig(): AppConfigService {
  // None of the four providers' getOrder() paths below read config: Salla/Zid
  // use a fixed base URL, and WooCommerce/Shopify are given their host
  // explicitly via `context` (siteUrl / shop) rather than falling back to a
  // deployment-wide env var — see the header comments in those two adapters.
  return {} as unknown as AppConfigService;
}

function fakeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

interface Case {
  name: string;
  fixture: unknown;
  externalOrderId: string;
  context?: StoreOAuthCallbackContext;
  connector: () => {
    getOrder: (
      accessToken: string,
      externalOrderId: string,
      context?: StoreOAuthCallbackContext,
    ) => Promise<StoreOrderSummary | null>;
  };
  expected: StoreOrderSummary;
}

const CASES: readonly Case[] = [
  {
    name: 'Salla',
    fixture: SALLA_ORDER_RESPONSE,
    externalOrderId: '900321',
    connector: () => new SallaStoreProvider(fakeConfig()),
    expected: {
      externalId: '900321',
      orderNumber: '900321',
      status: 'unknown',
      placedAt: new Date('2026-08-01T10:15:00Z'),
      total: 249.5,
      currency: 'SAR',
      customerPhone: '+966501234567',
      trackingNumber: 'SMSA-778812',
      items: [{ name: 'Abaya - Black, Size M', quantity: 1, price: 249.5 }],
    },
  },
  {
    name: 'Zid',
    fixture: ZID_ORDER_RESPONSE,
    externalOrderId: '68340124',
    // Zid sends a second (partner) token on every call; see zid-store.provider.ts.
    context: { shop: '3', authorizationToken: 'partner-token' },
    connector: () => new ZidStoreProvider(fakeConfig(), fakeLogger()),
    expected: {
      externalId: '68340124',
      orderNumber: '68340124',
      status: 'unknown',
      placedAt: new Date('2026-04-21T15:12:07Z'),
      total: 6954.6399840237,
      currency: 'EGP',
      customerPhone: '966333333333',
      trackingNumber: null,
      items: [
        {
          name: 'عطر برادا لا فيم انتنس النسائي - 100 مل',
          quantity: 1,
          price: 6664.8633180227,
        },
      ],
    },
  },
  {
    name: 'WooCommerce',
    fixture: WOOCOMMERCE_ORDER_RESPONSE,
    externalOrderId: '7781',
    context: { siteUrl: 'https://shop.example.com' },
    connector: () => new WooCommerceStoreProvider(fakeConfig()),
    expected: {
      externalId: '7781',
      orderNumber: '7781',
      status: 'unknown',
      placedAt: new Date('2026-08-05T12:30:00+03:00'),
      total: 156,
      currency: 'SAR',
      customerPhone: '+966501112222',
      trackingNumber: 'DHL-990011',
      items: [{ name: 'Ceramic Mug Set', quantity: 3, price: 52 }],
    },
  },
  {
    name: 'Shopify',
    fixture: SHOPIFY_ORDER_RESPONSE,
    externalOrderId: '5551234',
    context: { shop: 'test-store.myshopify.com' },
    connector: () => new ShopifyStoreProvider(fakeConfig(), fakeLogger()),
    expected: {
      externalId: '5551234',
      orderNumber: '#1042',
      status: 'unknown',
      placedAt: new Date('2026-08-10T09:00:00Z'),
      total: 310,
      currency: 'SAR',
      customerPhone: '+971501234567',
      trackingNumber: 'ARAMEX-11223',
      items: [{ name: 'Leather Wallet', quantity: 1, price: 310 }],
    },
  },
];

describe.each(CASES)(
  '$name order read-back contract',
  ({ fixture, externalOrderId, context, connector, expected }) => {
    it('parses the recorded response into the platform order-summary contract', async () => {
      serveOnce(fixture);

      const result = await connector().getOrder(
        'token',
        externalOrderId,
        context,
      );

      expect(result).toEqual(expected);
    });

    it('emits only statuses in the platform order-status vocabulary', async () => {
      serveOnce(fixture);

      const result = await connector().getOrder(
        'token',
        externalOrderId,
        context,
      );

      expect(result).not.toBeNull();
      expect(STORE_ORDER_STATUSES).toContain(result?.status);
    });

    it('carries no vendor status text out of the adapter', async () => {
      serveOnce(fixture);

      const result = await connector().getOrder(
        'token',
        externalOrderId,
        context,
      );

      // Unlike courier's ShipmentEvent, StoreOrderSummary has no `rawStatus`
      // passthrough field at all — the raw vendor status string (and any
      // injected prose riding inside it) must not appear anywhere in the
      // normalized result.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(INJECTION_MARKER);
    });
  },
);
