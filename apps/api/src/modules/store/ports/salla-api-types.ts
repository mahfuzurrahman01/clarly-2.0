// Feature 24 (Store Integrations): Salla-only response shapes and the pure
// mapping helpers the Salla adapter uses. Kept apart from store-api-types.ts
// because Salla's product and order shapes differ from Zid's, and the shared
// `Rest*` interfaces are what Zid relies on. Field names follow
// docs/integrations/SALLA.md; anything marked UNVERIFIED there is marked here.
import type { LocalizedName } from './store-api-types';
import type { StoreProduct } from './store-provider.port';

/** `GET https://accounts.salla.sa/oauth2/user/info`. */
export interface SallaUserInfoResponse {
  data?: {
    merchant?: {
      id?: string | number;
      name?: string;
      domain?: string;
    };
  };
}

export interface SallaProductPayload {
  id?: string | number;
  name?: LocalizedName;
  sku?: string;
  price?: { amount?: number | string; currency?: string };
  /** UNVERIFIED: may be null for unlimited-stock products. */
  quantity?: number | string | null;
  /** `sale` | `out` | `hidden`. */
  status?: string;
  images?: { url?: string; main?: boolean }[];
  categories?: { name?: string }[];
}

/**
 * UNVERIFIED: Salla's docs summary shows `{count,current,next}`; its other v2
 * APIs return `{currentPage,totalPages,links.next}`. Both are parsed.
 */
export interface SallaPagination {
  currentPage?: number;
  totalPages?: number;
  links?: { next?: string | null };
  current?: number;
  next?: string | null;
}

export interface SallaProductListResponse {
  data?: SallaProductPayload[];
  pagination?: SallaPagination;
}

/** `POST /orders` 201 body. */
export interface SallaCreateOrderResponse {
  data?: {
    id?: string | number;
    urls?: { customer?: string };
    amounts?: { total?: { amount?: number | string; currency?: string } };
  };
}

/** Salla's error envelope (`{ status, success: false, error: { message, fields } }`). */
export interface SallaErrorResponse {
  error?: {
    message?: string;
    fields?: Record<string, string[] | string>;
  };
  message?: string;
}

/** Longest vendor error text carried into our own error message and logs. */
const MAX_ERROR_DETAIL_LENGTH = 300;

/** Salla's `image.main` flag picks the cover image; otherwise the first one. */
export function sallaImageUrl(
  images: SallaProductPayload['images'],
): string | undefined {
  const list = images ?? [];
  return (list.find((image) => image.main) ?? list[0])?.url;
}

/**
 * `status: 'out'` wins over any quantity. A null/absent quantity is treated as
 * untracked (in stock): Salla omits a count for products without stock
 * tracking (UNVERIFIED), and calling those sold out would hide purchasable
 * products. `stock` is null in that case — no count is invented.
 */
export function sallaStock(product: SallaProductPayload): {
  stock: number | null;
  stockStatus: StoreProduct['stockStatus'];
} {
  const unlimited = product.quantity === null || product.quantity === undefined;
  if (unlimited) {
    return {
      stock: null,
      stockStatus: product.status === 'out' ? 'out_of_stock' : 'in_stock',
    };
  }
  const stock = Number(product.quantity) || 0;
  if (product.status === 'out') return { stock, stockStatus: 'out_of_stock' };
  return { stock, stockStatus: stock > 0 ? 'in_stock' : 'out_of_stock' };
}

/** The next page number, or undefined on the last page. */
export function sallaNextPage(
  pagination: SallaPagination | undefined,
  requestedPage: number,
): number | undefined {
  if (!pagination) return undefined;
  const current =
    Number(pagination.currentPage ?? pagination.current) || requestedPage;
  const hasNextLink = Boolean(pagination.links?.next ?? pagination.next);
  const total = Number(pagination.totalPages);
  const hasMorePages = Number.isFinite(total) && current < total;
  return hasNextLink || hasMorePages ? current + 1 : undefined;
}

/** Gulf dial codes → the ISO country code Salla's `receiver.country_code` takes. */
const COUNTRY_BY_DIAL_CODE: Readonly<Record<string, string>> = {
  '966': 'SA',
  '971': 'AE',
  '965': 'KW',
  '973': 'BH',
  '974': 'QA',
  '968': 'OM',
};

const DEFAULT_COUNTRY_CODE = 'SA';

/**
 * Splits an E.164-ish phone into Salla's `receiver.{country_code, phone}`.
 * UNVERIFIED: that `country_code` is ISO alpha-2 and `phone` is the national
 * number without its trunk `0`. A number with no recognised Gulf dial code is
 * sent whole under the default (Saudi) country.
 */
export function sallaReceiverPhone(raw: string): {
  country_code: string;
  phone: string;
} {
  const digits = raw.replace(/\D/g, '').replace(/^00/, '');
  for (const [dialCode, country] of Object.entries(COUNTRY_BY_DIAL_CODE)) {
    if (digits.startsWith(dialCode) && digits.length > dialCode.length + 6) {
      return { country_code: country, phone: digits.slice(dialCode.length) };
    }
  }
  return {
    country_code: DEFAULT_COUNTRY_CODE,
    phone: digits.replace(/^0/, ''),
  };
}

/** Salla's own error text, flattened and length-capped. Empty when there is none. */
export function sallaErrorDetail(body: unknown): string {
  const data = (body ?? {}) as SallaErrorResponse;
  const message = data.error?.message ?? data.message ?? '';
  const fields = Object.entries(data.error?.fields ?? {}).map(
    ([field, problems]) =>
      `${field}: ${Array.isArray(problems) ? problems.join(', ') : problems}`,
  );
  return [message, ...fields]
    .filter((part) => part.length > 0)
    .join('; ')
    .slice(0, MAX_ERROR_DETAIL_LENGTH);
}
