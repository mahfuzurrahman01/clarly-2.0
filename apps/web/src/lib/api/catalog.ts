import {
  API_BASE_URL,
  ApiError,
  apiFetch,
  browserAccessToken,
  browserApiFetch,
  reportIfSubscriptionInactive,
} from "./client";

/**
 * Feature 20 (Product Catalog & Stock) — console-side client for
 * `/catalog/products`. Mirrors `apps/api/src/modules/catalog/catalog.dto.ts`;
 * the controller there is the contract of record.
 *
 * Two wire details that bite if you assume otherwise:
 *  - `price` is a **string** on the wire (`numeric(12,2)`), a number on the
 *    way in. Never `Number()` it for display — format it, and send a number.
 *  - `createdAt`/`updatedAt` are Date objects server-side, ISO strings here.
 */

export const STOCK_STATUSES = [
  "in_stock",
  "out_of_stock",
  "low_stock",
  "pre_order",
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const CURRENCIES = [
  "SAR",
  "AED",
  "KWD",
  "QAR",
  "BHD",
  "OMR",
  "EGP",
  "USD",
] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Field limits, kept in step with catalog.dto.ts so the form fails before the round trip. */
export const MAX_NAME_LENGTH = 300;
export const MAX_SKU_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 5_000;
export const MAX_CATEGORY_LENGTH = 100;
export const MAX_IMAGE_URL_LENGTH = 2_000;
export const MAX_TAGS = 25;
export const MAX_TAG_LENGTH = 50;
export const MAX_PRICE = 9_999_999_999;
export const MAX_STOCK = 1_000_000_000;

/** Import ceilings enforced by CatalogImportService — checked client-side for a faster, clearer failure. */
export const MAX_IMPORT_ROWS = 1_000;
export const MAX_IMPORT_CSV_BYTES = 2_000_000;

/** The header CatalogImportService maps; also the export column order. */
export const CSV_TEMPLATE_HEADER =
  "name,name_ar,sku,price,currency,stock,category,description,description_ar,tags";

export type ProductRecord = {
  id: string;
  tenantId: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  description: string | null;
  descriptionAr: string | null;
  /** Decimal string, e.g. "149.00". */
  price: string;
  currency: string;
  /** Null when the connected store does not track this product's stock. */
  stock: number | null;
  stockStatus: string;
  imageUrl: string | null;
  imageObjectKey: string | null;
  category: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProductListResult = { products: ProductRecord[]; total: number };

export type ProductListQuery = {
  search?: string;
  category?: string;
  stockStatus?: StockStatus;
  limit?: number;
  offset?: number;
};

/** Server default is 20; the console pages in the same size so `total` maths line up. */
export const PRODUCTS_PAGE_SIZE = 20;

export function listProducts(query: ProductListQuery = {}, token?: string) {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.category) params.set("category", query.category);
  if (query.stockStatus) params.set("stock_status", query.stockStatus);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const qs = params.toString();
  const path = `/catalog/products${qs ? `?${qs}` : ""}`;
  return token
    ? apiFetch<ProductListResult>(path, { token })
    : browserApiFetch<ProductListResult>(path);
}

export type CreateProductInput = {
  name: string;
  nameAr?: string;
  sku?: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  currency?: Currency;
  stock?: number;
  stockStatus?: StockStatus;
  imageUrl?: string;
  category?: string;
  tags?: string[];
};

/** Every field optional, but the API rejects an empty body — callers must send at least one key. */
export type UpdateProductInput = Partial<CreateProductInput> & {
  isActive?: boolean;
};

export function createProduct(input: CreateProductInput) {
  return browserApiFetch<ProductRecord>("/catalog/products", {
    method: "POST",
    json: input,
  });
}

export function updateProduct(id: string, input: UpdateProductInput) {
  return browserApiFetch<ProductRecord>(`/catalog/products/${id}`, {
    method: "PATCH",
    json: input,
  });
}

/** Soft delete (`is_active = false`): the row stays for order history, it leaves the list. */
export function deleteProduct(id: string) {
  return browserApiFetch<void>(`/catalog/products/${id}`, { method: "DELETE" });
}

export type ImportRowError = { row: number; message: string };

export type ImportResult = {
  imported: number;
  updated: number;
  errors: ImportRowError[];
};

export function importProductsCsv(csv: string) {
  return browserApiFetch<ImportResult>("/catalog/products/import", {
    method: "POST",
    json: { csv },
  });
}

/** The API returns the CSV as a JSON string, not a file stream — the download is assembled in the browser. */
export function exportProductsCsv() {
  return browserApiFetch<{ csv: string }>("/catalog/products/export");
}

// --- Product images ---

/** The raster types the API accepts; anything else is a 400 before the bytes are read. */
export const PRODUCT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const PRODUCT_IMAGE_ACCEPT = PRODUCT_IMAGE_MIME_TYPES.join(",");

/** 5 MB, matching `MAX_PRODUCT_IMAGE_BYTES` in the API's product-image.ts. */
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * `POST /catalog/products/:id/image` — multipart, so it bypasses `apiFetch`
 * (which only speaks JSON) but keeps the same bearer and the same
 * subscription-gate behaviour. Returns the updated product: the server sets
 * `imageUrl`/`imageObjectKey` itself and deletes the object the previous
 * photo used.
 */
export async function uploadProductImage(
  productId: string,
  file: File,
): Promise<ProductRecord> {
  const token = await browserAccessToken();
  const body = new FormData();
  body.append("file", file);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/catalog/products/${productId}/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR");
  }

  if (!res.ok) {
    const err = new ApiError(res.status, await readErrorMessage(res));
    reportIfSubscriptionInactive(err);
    throw err;
  }
  return (await res.json()) as ProductRecord;
}

/**
 * True when `imageUrl` points at this API's own image route rather than a
 * merchant CDN. Those bytes need the bearer token, so they can't be loaded
 * by dropping the URL into an `<img src>`.
 */
export function isManagedProductImageUrl(url: string): boolean {
  return url.startsWith(`${API_BASE_URL}/catalog/products/`);
}

/** Fetches an API-hosted product image with the bearer token, for a blob URL. */
export async function fetchProductImageBlob(url: string): Promise<Blob> {
  const token = await browserAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
  return res.blob();
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string | string[] };
    const message = Array.isArray(data.message)
      ? data.message.join(", ")
      : data.message;
    return message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
