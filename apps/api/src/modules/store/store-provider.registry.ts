// Feature 24 (Store Integrations): one place that maps a connection's
// `provider` string to its adapter. Previously every service built its own
// private Map with the same lines (DRY violation, and four places to
// forget when a provider is added — WooCommerce was added in exactly one).
//
// An unknown provider resolves to the no-op adapter, which refuses orders and
// refuses webhook signatures — fail closed, never "pretend it worked".
import { Injectable } from '@nestjs/common';
import { NoopStoreProvider } from './ports/noop-store.provider';
import { SallaStoreProvider } from './ports/salla-store.provider';
import { ZidStoreProvider } from './ports/zid-store.provider';
import { ShopifyStoreProvider } from './ports/shopify-store.provider';
import { WooCommerceStoreProvider } from './ports/woocommerce-store.provider';
import type { StoreProvider } from './ports/store-provider.port';

@Injectable()
export class StoreProviderRegistry {
  private readonly providers: ReadonlyMap<string, StoreProvider>;

  constructor(
    salla: SallaStoreProvider,
    zid: ZidStoreProvider,
    shopify: ShopifyStoreProvider,
    woocommerce: WooCommerceStoreProvider,
    private readonly noop: NoopStoreProvider,
  ) {
    this.providers = new Map<string, StoreProvider>([
      ['salla', salla],
      ['zid', zid],
      ['shopify', shopify],
      ['woocommerce', woocommerce],
    ]);
  }

  forProvider(provider: string): StoreProvider {
    return this.providers.get(provider) ?? this.noop;
  }
}
