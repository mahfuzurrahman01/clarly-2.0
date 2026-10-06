// Feature 24 (Store Integrations): console-side client for `/store/connections`
// and `/store/connect/:provider`. Contract: docs/HANDOFF.md — the
// "F24 — WooCommerce connector" and "F24 — store_sync_jobs are written and
// visible" entries supersede the earlier F24 entries for the fields below.
//
// Two wire details that bite if you assume otherwise:
//  - `lastSyncedAt` is the last **successful** sync; `lastSync` is the last
//    **attempt** and may have failed. They answer different questions and
//    the UI must render both, not just one.
//  - All timestamps are ISO strings over the wire, never `Date` — format them,
//    never compare them directly.
import { apiFetch, browserApiFetch } from "./client";

export const STORE_PROVIDERS = ["salla", "zid", "shopify", "woocommerce"] as const;
export type StoreProviderName = (typeof STORE_PROVIDERS)[number];

/** The outcome of a connection's most recent sync attempt. Null until one has run. */
export type StoreSyncOutcome = {
  status: string;
  productsSynced: number;
  productsFailed: number;
  /** The provider/catalog failure, verbatim. Safe to render directly. */
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type ConnectedStore = {
  id: string;
  provider: StoreProviderName;
  storeId: string;
  storeName: string;
  storeUrl: string | null;
  isActive: boolean;
  /** When the connection last synced SUCCESSFULLY. `lastSync` says what happened on the last ATTEMPT. */
  lastSyncedAt: string | null;
  lastSync: StoreSyncOutcome | null;
};

export function listStoreConnections(token?: string) {
  const path = "/store/connections";
  return token
    ? apiFetch<ConnectedStore[]>(path, { token })
    : browserApiFetch<ConnectedStore[]>(path);
}

export type StoreConnectResult = { authorizeUrl: string; state: string };

export type ConnectStoreInput = {
  /** Shopify only: `<name>.myshopify.com`. */
  shop?: string;
  /** WooCommerce only: the merchant's own site. Required for that provider — the server 400s without it. */
  siteUrl?: string;
};

/**
 * Starts the OAuth flow. Redirect the browser to the returned `authorizeUrl` —
 * for Salla/Zid/Shopify that's the provider's own consent screen, for
 * WooCommerce it's the merchant's own site's `/wc-auth/v1/authorize` page.
 * `state` does not need to be stored or echoed by the frontend.
 */
export function connectStore(
  provider: StoreProviderName,
  input: ConnectStoreInput = {},
) {
  const params = new URLSearchParams();
  if (input.shop) params.set("shop", input.shop);
  if (input.siteUrl) params.set("siteUrl", input.siteUrl);
  const qs = params.toString();
  return browserApiFetch<StoreConnectResult>(
    `/store/connect/${provider}${qs ? `?${qs}` : ""}`,
    { method: "POST" },
  );
}

export function disconnectStore(connectionId: string) {
  return browserApiFetch<{ success: boolean }>(
    `/store/disconnect/${encodeURIComponent(connectionId)}`,
    { method: "POST" },
  );
}

/**
 * Client-side sanity check before submitting WooCommerce's `siteUrl` — the
 * server is the real validator (and additionally requires a resolvable
 * hostname), this only catches an obviously empty or malformed value before
 * a round trip.
 */
/** Shopify's per-shop host. The server enforces the same pattern before using it as an OAuth host. */
const SHOPIFY_SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Turns what a merchant types — `my-store`, `my-store.myshopify.com`, or a
 * pasted admin URL — into the bare `<name>.myshopify.com` the connect call
 * needs. Returns null when it cannot be one. Custom storefront domains
 * (`shop.example.com`) are not accepted: Shopify's OAuth host is always the
 * myshopify.com one.
 */
export function normalizeShopifyShop(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0];
  if (!host) return null;
  const shop = host.includes(".") ? host : `${host}.myshopify.com`;
  return SHOPIFY_SHOP_PATTERN.test(shop) ? shop : null;
}

export function isPlausibleSiteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.hostname.length > 3 && url.hostname.includes(".");
  } catch {
    return false;
  }
}
