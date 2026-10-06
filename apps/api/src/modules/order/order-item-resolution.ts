// F25 D2.2/D2.3/D2.4: turning the model's `{ productId, quantity }` list into
// priced line items, or failing the WHOLE order.
//
// A pure function over rows the caller already read, so every rejection branch
// is testable with no DB — and so the "price came from the products row, not
// from the tool args" property is provable rather than asserted.
//
// NEVER PARTIAL (F24 D9, kept): an unknown, inactive, out-of-stock,
// cross-tenant or mixed-currency item fails the entire order. Half an order is
// a customer who has been told they bought something they have not.
import type { OrderMode } from '../persistence/drizzle/tenant-order-settings.table';

/** The subset of a `products` row this resolution needs. */
export interface ResolvableProduct {
  id: string;
  tenantId: string;
  name: string;
  sku: string | null;
  price: string;
  currency: string;
  /** Null when the store does not count this product's stock. */
  stock: number | null;
  stockStatus: string;
  isActive: boolean;
  metadata: Record<string, unknown> | null;
}

export interface RequestedItem {
  productId: string;
  quantity: number;
  /**
   * The colour / size / model option the customer named, copied from the row
   * the model chose. Catalogue variants are separate rows ("Acme X200 Blender
   * - Black"), so a model that picks the plain row for "the red one" writes a
   * wrong order; when this is set the chosen row must actually carry it.
   */
  variant?: string;
}

export interface ResolvedItem {
  productId: string;
  productName: string;
  sku: string | null;
  unitPrice: string;
  currency: string;
  quantity: number;
  lineTotal: string;
  externalProductId: string | null;
  externalVariantId: string | null;
}

export interface ResolvedOrderItems {
  items: ResolvedItem[];
  subtotal: string;
  currency: string;
  /** True only when EVERY item resolved an external id for the pinned connection (D4.3). */
  storePushable: boolean;
}

/**
 * The machine-readable reasons the executor turns into a message for the
 * model. Deliberately coarse: an attacker probing product ids must not learn
 * whether an id exists in another tenant, so `unknown_product` covers both
 * "no such product" and "not yours".
 */
export type OrderResolutionFailure =
  | 'unknown_product'
  | 'inactive_product'
  | 'insufficient_stock'
  | 'mixed_currency'
  | 'variant_unavailable';

/** The stock fields of a `products` row, as both order-time stock checks read them. */
export interface StockSnapshot {
  stock: number | null;
  stockStatus: string;
}

/**
 * The one stock rule, used at create time AND at approve time (D2.4). A null
 * stock means the store does not count it, so there is no quantity to run
 * short of: only `stockStatus` can make it unorderable. A `pre_order` product
 * is sold ahead of stock, so its counted stock (usually 0) never blocks it.
 */
export function isOrderable(product: StockSnapshot, quantity: number): boolean {
  if (product.stockStatus === 'pre_order') return true;
  if (product.stock === null) return product.stockStatus !== 'out_of_stock';
  return product.stock >= quantity;
}

/** "X has only 2 in stock" — or, for an untracked product, "X is out of stock" (never "has only null"). */
export function describeStockShortfall(
  productName: string,
  stock: number | null,
): string {
  return stock === null
    ? `${productName} is out of stock`
    : `${productName} has only ${stock} in stock`;
}

export class OrderResolutionError extends Error {
  constructor(
    readonly failure: OrderResolutionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OrderResolutionError';
  }
}

/** Money is summed in integer minor units; floating-point addition is how "0.01 SAR out" bugs are born. */
function toMinorUnits(price: string): number {
  const parsed = Number(price);
  if (!Number.isFinite(parsed)) {
    throw new OrderResolutionError(
      'unknown_product',
      'A product in this order has an unreadable price.',
    );
  }
  return Math.round(parsed * 100);
}

function fromMinorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * Store sync records `{ source, storeExternalId }` on `products.metadata`;
 * that is the local↔store link. Resolved HERE, at order time, and snapshotted
 * onto the item — so a later re-sync cannot repoint an order already placed.
 */
function externalIdsFor(
  product: ResolvableProduct,
  provider: string | null,
): { productId: string | null; variantId: string | null } {
  const metadata = product.metadata ?? {};
  if (!provider || metadata.source !== provider) {
    return { productId: null, variantId: null };
  }
  const externalId = metadata.storeExternalId;
  const variantId = metadata.shopifyVariantId;
  return {
    productId:
      typeof externalId === 'string' && externalId.length > 0
        ? externalId
        : null,
    variantId:
      typeof variantId === 'string' && variantId.length > 0 ? variantId : null,
  };
}

/** Lowercase, Arabic letter forms folded, punctuation dropped: enough to compare "Black" with "- BLACK". */
function foldForVariantMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim();
}

/** True when every word of the requested variant appears in the row's name or sku. */
function rowCarriesVariant(
  product: ResolvableProduct,
  variant: string,
): boolean {
  const wanted = foldForVariantMatch(variant);
  if (wanted.length === 0) return true;
  const haystack = ` ${foldForVariantMatch(`${product.name} ${product.sku ?? ''}`)} `;
  return wanted.split(' ').every((word) => haystack.includes(word));
}

export function resolveOrderItems(
  requested: readonly RequestedItem[],
  products: readonly ResolvableProduct[],
  options: { storeProvider?: string | null } = {},
): ResolvedOrderItems {
  const byId = new Map(products.map((product) => [product.id, product]));
  const provider = options.storeProvider ?? null;

  const items: ResolvedItem[] = [];
  let subtotalMinor = 0;
  let currency: string | null = null;
  let storePushable = provider !== null;

  for (const request of requested) {
    const product = byId.get(request.productId);

    // "Not found" and "belongs to another tenant" are ONE answer on purpose.
    // The caller only ever passes rows it read under this tenant's RLS
    // context, so a cross-tenant id simply is not in the map — and the model
    // (and therefore an injecting customer) learns nothing either way.
    if (!product) {
      throw new OrderResolutionError(
        'unknown_product',
        `Product ${request.productId} is not in this workspace's catalogue.`,
      );
    }

    if (!product.isActive) {
      throw new OrderResolutionError(
        'inactive_product',
        `${product.name} is no longer available.`,
      );
    }

    if (request.variant && !rowCarriesVariant(product, request.variant)) {
      throw new OrderResolutionError(
        'variant_unavailable',
        `The product chosen (${product.name}) is not the "${request.variant}" variant the customer asked for. Do not order it. If a lookup_product row for that variant exists, order that row; if none exists or it is out of stock, tell the customer it is unavailable and escalate.`,
      );
    }

    if (!isOrderable(product, request.quantity)) {
      throw new OrderResolutionError(
        'insufficient_stock',
        product.stock === null
          ? `${describeStockShortfall(product.name, null)}.`
          : `${describeStockShortfall(product.name, product.stock)} (requested ${request.quantity}).`,
      );
    }

    // D2.3: an order is single-currency. Summing SAR and AED into one total is
    // a money bug, and picking one silently is worse.
    if (currency === null) {
      currency = product.currency;
    } else if (currency !== product.currency) {
      throw new OrderResolutionError(
        'mixed_currency',
        `This order mixes ${currency} and ${product.currency}; a single order must be in one currency.`,
      );
    }

    const unitMinor = toMinorUnits(product.price);
    const lineMinor = unitMinor * request.quantity;
    subtotalMinor += lineMinor;

    const external = externalIdsFor(product, provider);
    if (!external.productId) storePushable = false;

    items.push({
      productId: product.id,
      // Name and price come from the ROW, never from the tool arguments.
      productName: product.name,
      sku: product.sku,
      unitPrice: fromMinorUnits(unitMinor),
      currency: product.currency,
      quantity: request.quantity,
      lineTotal: fromMinorUnits(lineMinor),
      externalProductId: external.productId,
      externalVariantId: external.variantId,
    });
  }

  if (items.length === 0 || currency === null) {
    throw new OrderResolutionError(
      'unknown_product',
      'An order must contain at least one product.',
    );
  }

  return {
    items,
    subtotal: fromMinorUnits(subtotalMinor),
    currency,
    storePushable,
  };
}

/** D2.1: the status a freshly created order starts in, decided by the tenant's mode. */
export function initialStatusForMode(
  mode: Exclude<OrderMode, 'disabled'>,
): 'pending_approval' | 'confirmed' {
  return mode === 'auto' ? 'confirmed' : 'pending_approval';
}
