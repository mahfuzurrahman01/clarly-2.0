// Feature 24 (Store Integrations): the shapes we actually rely on from
// Salla's and WooCommerce's REST responses (Zid's live in zid-api-types.ts).
// `fetch().json()` is `any`, and an `any` flowing into a token field or a
// product id is how "the response changed shape" turns into a silent wrong
// value instead of a thrown error — so every response is narrowed through one
// of these, in one place, for both adapters.
import type {
  StoreOrderStatus,
  StoreOrderSummary,
} from './store-provider.port';

export interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Zid (standard OAuth). */
  expires_in?: number | string;
  /** Salla's name for the same lifetime in seconds. */
  expires?: number | string;
}

/** Salla returns either a plain name or `{ ar, en }`; some payloads carry a separate `name_ar`. */
export type LocalizedName = string | { ar?: string; en?: string } | undefined;

export interface RestProductPayload {
  id?: string | number;
  name?: LocalizedName;
  name_ar?: string;
  price?: string | number;
  stock?: string | number;
  images?: string[];
  sku?: string;
  category?: { name?: string };
}

export interface RestWebhookPayload {
  event?: string;
  event_id?: string | number;
  id?: string | number;
  data?: Record<string, unknown> & { id?: string | number };
}

// ---- Order read-back ----
//
// One payload interface covers Salla and WooCommerce because both
// are "REST resource with an id, a status, a total, a customer and lines" and
// differ only in which of two or three field names they use. Every field is
// optional and every reader below narrows: an order shape that changes must
// degrade to `unknown`/null, never produce a confidently wrong answer about
// someone's money.
//
// UNVERIFIED: these field names come from each vendor's published REST
// documentation. No call has ever been made from this repo against a Salla,
// Zid, Shopify or WooCommerce account, so the mapping below is documentation-
// accurate, not observation-accurate. A recorded-fixture contract test (the
// `test:courier-contract` pattern F26 D10 specifies) is the thing that would
// turn a vendor rename into a failing test instead of a silent `unknown`.

export type MoneyPayload =
  number | string | { amount?: number | string; currency?: string };

export interface RestOrderLinePayload {
  name?: LocalizedName;
  quantity?: number | string;
  price?: MoneyPayload;
}

export interface RestOrderPayload {
  id?: string | number;
  /** Salla's human reference; WooCommerce's `number`. */
  reference_id?: string | number;
  number?: string | number;
  status?: string | { name?: string; slug?: string };
  total?: MoneyPayload;
  currency?: string;
  date_created?: string;
  created_at?: string;
  date?: string | { date?: string };
  customer?: { mobile?: string; phone?: string };
  billing?: { phone?: string };
  shipping?: { tracking_number?: string };
  tracking_number?: string;
  items?: RestOrderLinePayload[];
  line_items?: RestOrderLinePayload[];
}

export interface RestOrderDetailResponse {
  data?: RestOrderPayload;
}

export interface RestOrderListResponse {
  data?: RestOrderPayload[];
}

/**
 * Provider status slug → the platform's own vocabulary. Anything unrecognised
 * becomes `unknown` rather than being passed through: downstream (and the
 * model) must never see a provider's raw status string.
 */
const ORDER_STATUS_BY_SLUG: Readonly<Record<string, StoreOrderStatus>> = {
  pending: 'pending',
  'pending-payment': 'pending',
  pending_payment: 'pending',
  'under-review': 'pending',
  payment_pending: 'pending',
  processing: 'processing',
  'in-progress': 'processing',
  in_progress: 'processing',
  preparing: 'processing',
  shipped: 'processing',
  'on-hold': 'on_hold',
  on_hold: 'on_hold',
  onhold: 'on_hold',
  completed: 'completed',
  delivered: 'completed',
  fulfilled: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  refunded: 'refunded',
  restored: 'refunded',
  failed: 'failed',
};

export function normalizeOrderStatus(
  raw: string | { name?: string; slug?: string } | undefined,
): StoreOrderStatus {
  const text = typeof raw === 'string' ? raw : (raw?.slug ?? raw?.name ?? '');
  const key = text.trim().toLowerCase().replace(/\s+/g, '-');
  return ORDER_STATUS_BY_SLUG[key] ?? 'unknown';
}

export function amountOf(value: MoneyPayload | undefined): number {
  if (value === undefined || value === null) return 0;
  const raw = typeof value === 'object' ? value.amount : value;
  const amount = Number(raw ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function dateOf(payload: RestOrderPayload): Date | null {
  const raw =
    payload.date_created ??
    payload.created_at ??
    (typeof payload.date === 'string' ? payload.date : payload.date?.date);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The shared Salla/WooCommerce order projection. Shopify and Zid have their own mappers. */
export function restOrderToSummary(
  payload: RestOrderPayload,
  fallbackCurrency: string,
): StoreOrderSummary {
  const externalId = idOf(payload.id);
  const total =
    typeof payload.total === 'object' && payload.total !== null
      ? payload.total
      : payload.total;
  const currency =
    (typeof total === 'object' ? total?.currency : undefined) ??
    payload.currency ??
    fallbackCurrency;
  const lines = payload.line_items ?? payload.items ?? [];

  return {
    externalId,
    orderNumber:
      idOf(payload.reference_id) || idOf(payload.number) || externalId,
    status: normalizeOrderStatus(payload.status),
    placedAt: dateOf(payload),
    total: amountOf(payload.total),
    currency,
    customerPhone:
      payload.customer?.mobile ??
      payload.customer?.phone ??
      payload.billing?.phone ??
      null,
    trackingNumber:
      payload.shipping?.tracking_number ?? payload.tracking_number ?? null,
    items: lines.map((line) => {
      const { name } = resolveNames({ name: line.name });
      return {
        name,
        quantity: Number(line.quantity ?? 0) || 0,
        price: amountOf(line.price),
      };
    }),
  };
}

export function resolveNames(product: RestProductPayload): {
  name: string;
  nameAr?: string;
} {
  const { name } = product;
  if (typeof name === 'string') {
    return { name, nameAr: product.name_ar };
  }
  return {
    name: name?.en ?? '',
    nameAr: name?.ar ?? product.name_ar,
  };
}

export function requireAccessToken(
  provider: string,
  response: OAuthTokenResponse,
): string {
  if (!response.access_token) {
    throw new Error(`${provider} token response contained no access_token`);
  }
  return response.access_token;
}

export function expiryFrom(response: OAuthTokenResponse): Date | undefined {
  const seconds = Number(response.expires_in ?? response.expires);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000)
    : undefined;
}

export function idOf(value: string | number | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}
