// Feature 24 (Store Integrations): the one place the supported provider names
// live, so controllers can validate an untrusted `:provider` path param
// against the same list the adapters and the `store_connections.provider`
// column use.
//
// All four providers GULF_PARITY_PLAN.md's F24 line names — Salla, Zid,
// Shopify and WooCommerce — are present. WooCommerce was the last one added
// (it has an adapter, config and migration 0058's CHECK constraint); this
// comment previously recorded its deliberate absence.
import { STORE_PROVIDERS } from '../persistence/drizzle/store-connections.table';

export type StoreProviderName = (typeof STORE_PROVIDERS)[number];

export function isStoreProviderName(
  value: unknown,
): value is StoreProviderName {
  return (
    typeof value === 'string' &&
    (STORE_PROVIDERS as readonly string[]).includes(value)
  );
}
