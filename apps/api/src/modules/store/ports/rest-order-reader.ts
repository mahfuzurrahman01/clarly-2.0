// Feature 24 (Store Integrations): the shared REST order-read implementation
// for Salla and WooCommerce.
//
// Both expose "GET /orders/{id}" and "GET /orders?<phone param>=…"
// returning the same order shape (`RestOrderPayload`), differing only in the
// auth header, the query-parameter name, and whether the list is wrapped in a
// `data` envelope. Two copies of this would be two places to apply the next
// fix — the same DRY argument `StoreProviderRegistry` records for adapter
// lookup. Shopify is not here: its Admin API is GraphQL. Zid is not here
// either: its order routes (`/managers/store/orders/{id}/view`), envelopes
// (`{ order }` / `{ orders }`) and order shape all differ, so it reads its
// own (zid-store.provider.ts) rather than bending this one.
import {
  restOrderToSummary,
  type RestOrderDetailResponse,
  type RestOrderPayload,
} from './store-api-types';
import type { StoreOrderSummary } from './store-provider.port';

export interface RestOrderReadOptions {
  /** Used only in error messages. */
  provider: string;
  /** Fully-qualified API root, no trailing slash (`https://api.salla.dev/admin/v2`). */
  baseUrl: string;
  /** Auth header(s) for this provider — Bearer for Salla, Basic for WooCommerce. */
  headers: Record<string, string>;
  /** Currency used when the payload carries none. */
  fallbackCurrency: string;
}

/** Ceiling on a customer's order history. "Where is my order" needs the recent ones, not every order ever placed. */
export const ORDER_HISTORY_LIMIT = 20;

/** Some providers return a bare array, some wrap it in `{ data: [...] }`. */
function orderList(json: unknown): RestOrderPayload[] {
  if (Array.isArray(json)) return json as RestOrderPayload[];
  const wrapped = (json ?? {}) as { data?: RestOrderPayload[] };
  return Array.isArray(wrapped.data) ? wrapped.data : [];
}

function orderDetail(json: unknown): RestOrderPayload | null {
  if (json === null || typeof json !== 'object') return null;
  const wrapped = json as RestOrderDetailResponse & RestOrderPayload;
  const payload = wrapped.data ?? wrapped;
  return payload.id === undefined ? null : payload;
}

/**
 * One order by store id. 404 is null, not a throw: "this store has no order
 * #1234" is an ordinary answer, and it must be indistinguishable from "that
 * order is not yours" — an error that leaked the difference would be an
 * existence oracle across customers.
 */
export async function readRestOrder(
  options: RestOrderReadOptions,
  externalOrderId: string,
): Promise<StoreOrderSummary | null> {
  const res = await fetch(
    `${options.baseUrl}/orders/${encodeURIComponent(externalOrderId)}`,
    { headers: options.headers },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`${options.provider} order read failed: ${res.status}`);
  }
  const payload = orderDetail(await res.json());
  return payload ? restOrderToSummary(payload, options.fallbackCurrency) : null;
}

/**
 * A phone's order history, newest first. `phoneParam` is the provider's own
 * search-by-phone query parameter.
 */
export async function listRestOrdersByPhone(
  options: RestOrderReadOptions,
  phoneParam: string,
  customerPhone: string,
): Promise<StoreOrderSummary[]> {
  const params = new URLSearchParams({
    [phoneParam]: customerPhone,
    per_page: String(ORDER_HISTORY_LIMIT),
  });
  const res = await fetch(`${options.baseUrl}/orders?${params.toString()}`, {
    headers: options.headers,
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`${options.provider} order list failed: ${res.status}`);
  }
  return orderList(await res.json())
    .map((payload) => restOrderToSummary(payload, options.fallbackCurrency))
    .slice(0, ORDER_HISTORY_LIMIT);
}
