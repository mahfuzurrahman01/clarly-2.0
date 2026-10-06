// Feature 24 (Store Integrations): Zid-only response shapes and the pure
// mapping helpers the Zid adapter uses. Kept apart from store-api-types.ts for
// the same reason salla-api-types.ts is: Zid's product, order and token shapes
// share nothing with the generic `Rest*` interfaces. Field names follow
// docs/integrations/ZID.md (transcribed from docs.zid.sa on 2026-10-03);
// anything marked UNVERIFIED there is marked here. No call has been made
// against a live Zid store.
import type { OAuthTokenResponse } from './store-api-types';
import type {
  StoreOrderStatus,
  StoreOrderSummary,
  StoreProduct,
} from './store-provider.port';

/**
 * `POST https://oauth.zid.sa/oauth/token`. `access_token` is the manager token
 * (`X-Manager-Token`), `authorization` the partner token (`Authorization:
 * Bearer`). The sample app reads `authorization`; the docs' prose lists it
 * as `Authorization` — both spellings are read (UNVERIFIED which one ships).
 */
export interface ZidTokenResponse extends OAuthTokenResponse {
  authorization?: string;
  Authorization?: string;
}

/** `GET /v1/managers/account/profile`, trimmed to what we read. */
export interface ZidProfileResponse {
  user?: {
    store?: {
      id?: number | string;
      title?: string;
      url?: string;
      currency?: { code?: string };
    };
  };
}

export interface ZidLocalized {
  ar?: string | null;
  en?: string | null;
}

/** One entry of `GET /v1/products/` → `results[]`. */
export interface ZidProductPayload {
  id?: string;
  sku?: string;
  parent_id?: string | null;
  structure?: string;
  name?: ZidLocalized | string;
  price?: number | string | null;
  sale_price?: number | string | null;
  currency?: string;
  quantity?: number | null;
  is_infinite?: boolean | null;
  is_draft?: boolean;
  html_url?: string;
  images?: {
    image?: {
      thumbnail?: string;
      small?: string;
      medium?: string;
      large?: string;
      full_size?: string;
    };
  }[];
  categories?: { id?: string | number; name?: ZidLocalized | string }[];
}

/** Django-style pagination: `next` is a URL while more pages exist. */
export interface ZidProductListResponse {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: ZidProductPayload[];
}

export interface ZidOrderPayload {
  id?: number | string;
  invoice_number?: number | string;
  code?: string;
  order_status?: { name?: string; code?: string };
  currency_code?: string;
  customer?: { name?: string; email?: string; mobile?: string | null };
  /** A decimal STRING (`'6954.63998402370000'`). */
  order_total?: string | number;
  payment_status?: string;
  /** `'2026-04-21 15:12:07'` — no zone; see zidDate(). */
  created_at?: string;
  shipping?: { method?: { tracking?: { number?: string | null } } };
  products?: {
    name?: string | ZidLocalized;
    quantity?: number | string;
    price?: number | string;
  }[];
}

/** `GET /v1/managers/store/orders/{id}/view`. */
export interface ZidOrderViewResponse {
  order?: ZidOrderPayload;
}

/** `GET /v1/managers/store/orders`. */
export interface ZidOrderListResponse {
  orders?: ZidOrderPayload[];
  total_order_count?: number;
}

/**
 * A store-event delivery (order / product). UNVERIFIED as a whole: the docs
 * link the payload schemas (DataSchema 2771504 order, 2771485 product) but do
 * not inline them, and no envelope is documented. This type lists every
 * shape the normalizer tolerates: an event name in `event` or `event_name`,
 * the resource either under `data` or at the top level. App Market events
 * (`app.market.*`) do document `event_name` + `store_id`.
 */
export interface ZidWebhookPayload {
  event?: string;
  event_name?: string;
  store_id?: number | string;
  id?: number | string;
  updated_at?: string;
  data?: Record<string, unknown> & {
    id?: number | string;
    updated_at?: string;
  };
}

/** Zid's error envelope: `{ status: 'error', message: { code, name, description, validations? } }`. */
export interface ZidErrorResponse {
  message?:
    | string
    | {
        code?: string | null;
        name?: string | null;
        description?: string | null;
      };
}

/** Longest vendor error text carried into our own error message and logs. */
const MAX_ERROR_DETAIL_LENGTH = 300;

/**
 * Zid order status codes (`order_status.code`) → the platform vocabulary.
 * Webhook conditions spell in-delivery `inDelivery`; the order payload's code
 * is compared lower-cased so both spellings land. Merchant custom
 * sub-statuses are not in the docs and map to `unknown`.
 */
const ZID_ORDER_STATUS: Readonly<Record<string, StoreOrderStatus>> = {
  new: 'pending',
  preparing: 'processing',
  ready: 'processing',
  indelivery: 'processing',
  delivered: 'completed',
  cancelled: 'cancelled',
};

export function zidOrderStatus(code: string | undefined): StoreOrderStatus {
  return ZID_ORDER_STATUS[(code ?? '').trim().toLowerCase()] ?? 'unknown';
}

/** The partner token from a token response, whichever spelling it came in. */
export function zidAuthorizationToken(
  response: ZidTokenResponse,
): string | undefined {
  const token = response.authorization ?? response.Authorization;
  return token && token.length > 0 ? token : undefined;
}

function textOf(value: ZidLocalized | string | undefined | null): {
  en?: string;
  ar?: string;
} {
  if (typeof value === 'string') return { en: value };
  return { en: value?.en ?? undefined, ar: value?.ar ?? undefined };
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The first image's URL, largest rendition first. */
export function zidImageUrl(
  images: ZidProductPayload['images'],
): string | undefined {
  const image = images?.[0]?.image;
  return (
    image?.full_size ??
    image?.large ??
    image?.medium ??
    image?.small ??
    image?.thumbnail
  );
}

/**
 * `is_infinite` products are untracked: stock null, in stock. A counted
 * product with no `quantity` reads as 0 (sold out) rather than inventing a
 * count.
 */
function zidStock(product: ZidProductPayload): {
  stock: number | null;
  stockStatus: StoreProduct['stockStatus'];
} {
  if (product.is_infinite) return { stock: null, stockStatus: 'in_stock' };
  const stock = finiteNumber(product.quantity) ?? 0;
  return { stock, stockStatus: stock > 0 ? 'in_stock' : 'out_of_stock' };
}

/**
 * One List Products row → StoreProduct. `price` is the list price; a non-null
 * `sale_price` is kept in metadata only, because the docs also carry a sale
 * period (`purchase_restrictions.sale_price_period_*`) we do not evaluate —
 * quoting a sale price outside its window would be wrong (UNVERIFIED whether
 * Zid nulls `sale_price` outside the window).
 */
export function zidProductToStoreProduct(
  product: ZidProductPayload,
  fallbackCurrency: string,
): StoreProduct {
  const name = textOf(product.name);
  const category = textOf(product.categories?.[0]?.name);
  const salePrice = finiteNumber(product.sale_price);
  return {
    externalId: product.id ?? '',
    name: name.en || name.ar || '',
    nameAr: name.ar || undefined,
    price: finiteNumber(product.price) ?? 0,
    currency: product.currency || fallbackCurrency,
    ...zidStock(product),
    imageUrl: zidImageUrl(product.images),
    sku: product.sku || undefined,
    category: category.en || category.ar || undefined,
    metadata: {
      ...(salePrice === undefined ? {} : { salePrice }),
      ...(product.structure ? { structure: product.structure } : {}),
      ...(product.parent_id ? { parentId: product.parent_id } : {}),
      ...(product.html_url ? { url: product.html_url } : {}),
    },
  };
}

/**
 * `created_at` has no zone (`'2026-04-21 15:12:07'`). Read as UTC: in the
 * View Order example the same order's `issue_date` is `21-04-2026 | 06:12 م`
 * (18:12 Riyadh, UTC+3), which matches 15:12 UTC. Inferred from one example,
 * not stated by the docs (UNVERIFIED).
 */
export function zidDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One order (View Order / List Orders) → the platform summary. `orderNumber`
 * is the numeric id: the docs show `invoice_number` equal to `id`, and the
 * alphanumeric `code` is the invoice-URL token (UNVERIFIED which one the
 * storefront shows the customer as "order number").
 */
export function zidOrderToSummary(
  order: ZidOrderPayload,
  fallbackCurrency: string,
): StoreOrderSummary {
  const externalId =
    order.id === undefined || order.id === null ? '' : String(order.id);
  return {
    externalId,
    orderNumber:
      order.invoice_number === undefined || order.invoice_number === null
        ? externalId
        : String(order.invoice_number),
    status: zidOrderStatus(order.order_status?.code),
    placedAt: zidDate(order.created_at),
    total: finiteNumber(order.order_total) ?? 0,
    currency: order.currency_code || fallbackCurrency,
    customerPhone: order.customer?.mobile || null,
    trackingNumber: order.shipping?.method?.tracking?.number || null,
    items: (order.products ?? []).map((line) => {
      const name = textOf(line.name);
      return {
        name: name.en || name.ar || '',
        quantity: finiteNumber(line.quantity) ?? 0,
        price: finiteNumber(line.price) ?? 0,
      };
    }),
  };
}

/** `Authorization: Basic base64(username:password)`, as Zid sends it (Create Webhook docs). */
export function zidBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** Zid's own error text, length-capped. Empty when there is none. */
export function zidErrorDetail(body: unknown): string {
  const message = ((body ?? {}) as ZidErrorResponse).message;
  const text =
    typeof message === 'string'
      ? message
      : [message?.code, message?.description].filter(Boolean).join(': ');
  return text.slice(0, MAX_ERROR_DETAIL_LENGTH);
}
