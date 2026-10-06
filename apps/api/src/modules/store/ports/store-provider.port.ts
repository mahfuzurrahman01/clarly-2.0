// Feature 24 (Store Integrations): D1-style provider-portability port for
// e-commerce store operations — Salla, Zid, Shopify, WooCommerce. Following
// the billing provider pattern: abstract class as DI token, adapters as
// concrete bindings.
//
// The port is NOT single-tenant like BillingProvider. Each store connection has
// its own `provider` field, so the service selects the right adapter at runtime
// per connection.
import { timingSafeEqual } from 'node:crypto';

export interface StoreProduct {
  externalId: string;
  name: string;
  nameAr?: string;
  price: number;
  currency: string;
  /** Null when the store does not track this product's stock; `stockStatus` still says whether it sells. */
  stock: number | null;
  stockStatus: 'in_stock' | 'out_of_stock' | 'low_stock' | 'pre_order';
  imageUrl?: string;
  sku?: string;
  category?: string;
  metadata: Record<string, unknown>;
}

export interface StoreOrderItem {
  productId: string;
  variantId?: string;
  quantity: number;
  price: number;
}

export interface StoreOrderResult {
  orderId: string;
  paymentUrl: string;
  total: number;
  currency: string;
}

export interface StoreOAuthUrls {
  authorizeUrl: string;
  state: string;
}

export interface StoreTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  /**
   * Zid only: the partner `authorization` token. Zid issues two tokens and
   * every Merchant API call sends both (`Authorization: Bearer
   * <authorizationToken>` + `X-Manager-Token: <accessToken>`). Absent for
   * every other provider, and absent from a Zid refresh that did not return
   * one (the stored value is then kept).
   */
  authorizationToken?: string;
}

export interface StoreConnectionTokens extends StoreTokens {
  storeId: string;
  storeName: string;
  storeUrl?: string;
}

/**
 * Extra, provider-specific data that arrives on the OAuth callback URL.
 * Shopify is the reason this exists: the merchant's shop domain is only known
 * at callback time (`?shop=acme.myshopify.com`), so it cannot come from a
 * single platform-level env var if more than one merchant ever connects.
 *
 * WooCommerce has the same problem in a stronger form — every WooCommerce
 * merchant is a *self-hosted* WordPress site, so there is no hosted platform
 * host at all and `siteUrl` is the only thing that says which site to talk to.
 * It is carried here for the same reason `shop` is, rather than as a
 * deployment-wide `WOOCOMMERCE_SITE_URL` env var, which would cap the
 * deployment at exactly one merchant.
 */
export interface StoreOAuthCallbackContext {
  shop?: string;
  /** WooCommerce only. Origin of the merchant's own site (`https://shop.example.com`). Falls back to `shop` when absent, since `store_connections.store_id` holds the site host for WooCommerce. */
  siteUrl?: string;
  /**
   * Zid only: the connection's partner `authorization` token (see
   * `StoreTokens.authorizationToken`). Carried here, beside the access token
   * argument, because it is per-connection data the adapter needs on every
   * call. Zid also reads its numeric store id from `shop` (the `Store-Id`
   * header on product endpoints), since `store_connections.store_id` holds it.
   */
  authorizationToken?: string;
}

/**
 * What a provider that subscribes webhooks by API needs to point them at us
 * and authenticate them. Zid: Basic-auth credentials we choose at subscription
 * time, so the per-connection secret is the password.
 */
export interface StoreWebhookRegistration {
  /** The id `/store/webhook/<provider>/<storeId>` is keyed on. */
  storeId: string;
  /** Plaintext per-connection webhook secret, as minted at connect time. */
  webhookSecret: string;
}

/**
 * The platform's normalized order-status vocabulary. Every provider's own
 * status string is mapped INTO this; nothing downstream (console, agent,
 * F25/F26) ever reads a provider's raw status text — the same rule F26's
 * `ShipmentStatus` sets for couriers, for the same reason: a third-party
 * string rendered into a prompt is a prompt-injection surface.
 */
export type StoreOrderStatus =
  | 'pending'
  | 'processing'
  | 'on_hold'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed'
  | 'unknown';

export interface StoreOrderLine {
  name: string;
  quantity: number;
  price: number;
}

/**
 * One order as read back from the store — the "where is my order #1234"
 * payload. Deliberately a small, fully-typed projection rather than the
 * provider's raw order object: everything here is provider-controlled input.
 */
export interface StoreOrderSummary {
  /** The store's own order id — the handle a later call re-reads it by. */
  externalId: string;
  /** The human-facing reference the customer actually quotes ("#1234"). Equal to `externalId` for providers that have only one. */
  orderNumber: string;
  status: StoreOrderStatus;
  placedAt: Date | null;
  total: number;
  currency: string;
  /**
   * The phone the order was placed under, as the STORE holds it. This is the
   * value `StoreOrderLookupService` matches the asking customer against, so
   * an order the provider returns without a phone can never be matched to a
   * caller and is therefore never returned to one. Never rendered to the
   * customer.
   */
  customerPhone: string | null;
  trackingNumber: string | null;
  items: StoreOrderLine[];
}

/**
 * `order_updated`: an existing order's status or payment status changed
 * (Zid's `order.status.update` / `order.payment_status.update`).
 * `inventory_changed`: the store says stock moved but gives no product-level
 * count we can apply (Shopify's `inventory_levels/update` is per inventory
 * item and per location), so the connection is re-synced instead.
 * `app_uninstalled`: the merchant removed our app; the connection is dead.
 */
export interface StoreWebhookEvent {
  eventType:
    | 'order_created'
    | 'order_updated'
    | 'stock_changed'
    | 'inventory_changed'
    | 'product_updated'
    | 'app_uninstalled'
    | 'unknown';
  externalId: string;
  storeId: string;
  payload: Record<string, unknown>;
}

export type StoreWebhookHeaders = Record<string, string | undefined>;

export abstract class StoreProvider {
  abstract readonly provider: 'salla' | 'zid' | 'shopify' | 'woocommerce';

  /**
   * The header this provider actually signs its webhooks with. The previous
   * implementation read one invented `x-webhook-signature` header for every
   * provider, which meant no real webhook was ever verified.
   */
  abstract readonly webhookSignatureHeader: string;

  // OAuth
  /**
   * The merchant-side host to seal into the signed connect state at initiate
   * time (the request is authenticated then; the callback is not). Default:
   * the WooCommerce `siteUrl`, absent for every platform-hosted provider.
   * Shopify overrides it with the validated shop domain.
   */
  connectBinding(
    context?: StoreOAuthCallbackContext,
  ): Pick<StoreOAuthCallbackContext, 'siteUrl' | 'shop'> {
    return { siteUrl: context?.siteUrl };
  }

  /**
   * Provider signature over the OAuth callback's query string, checked before
   * the code is exchanged. Gets EVERY query param, because the signature
   * covers params we otherwise ignore. Default: true (Salla, Zid and
   * WooCommerce sign nothing on the callback; the signed state is the check).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default accepts; only Shopify signs its callback.
  verifyCallbackSignature(query: Readonly<Record<string, unknown>>): boolean {
    return true;
  }

  /**
   * Subscribes this store's events to our webhook route after a connect.
   * Default: no-op (Salla and WooCommerce webhooks are configured on the
   * provider side). Shopify and Zid override it. Must be safe to call again
   * on a reconnect. Throws when any subscription failed; the caller logs it
   * and keeps the connection.
   */
  /* eslint-disable @typescript-eslint/no-unused-vars -- the default registers nothing; Shopify and Zid override. */
  registerWebhooks(
    accessToken: string,
    context?: StoreOAuthCallbackContext,
    registration?: StoreWebhookRegistration,
  ): Promise<void> {
    return Promise.resolve();
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  abstract getOAuthAuthorizeUrl(
    state: string,
    context?: StoreOAuthCallbackContext,
  ): string;
  abstract exchangeCode(
    code: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreConnectionTokens>;

  /**
   * Refresh-token grant. Separate from exchangeCode() because they are
   * different grants (`refresh_token` vs `authorization_code`) — calling
   * exchangeCode() with a refresh token, as the first cut did, always fails
   * against a real provider.
   *
   * Returns null for providers whose tokens do not expire and have no refresh
   * grant (Shopify offline access tokens).
   */
  abstract refreshAccessToken(
    refreshToken: string,
  ): Promise<StoreTokens | null>;

  // Product sync
  abstract listProducts(
    accessToken: string,
    after?: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<{
    products: StoreProduct[];
    hasNextPage: boolean;
    nextCursor?: string;
  }>;

  // Order creation
  abstract createOrder(
    accessToken: string,
    order: {
      customerId?: string;
      customerPhone: string;
      customerName: string;
      shippingAddress: string;
      items: StoreOrderItem[];
      notes?: string;
    },
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderResult>;

  // Order read-back — the store side of "where is my order #1234"
  // (GULF_PARITY_PLAN F24: "Order read access ... used by F25/F26").
  //
  // SECURITY: neither method is an authorization boundary and neither may be
  // called with a customer identity the agent supplied. The adapter's job is
  // only to talk to the store; `StoreOrderLookupService` is the single place
  // that decides WHOSE orders these are, from the caller's own
  // conversation/customer context. See its header comment.

  /**
   * One order by the store's own id. Returns null for "no such order in this
   * store" — an unknown reference is an ordinary answer, not an error, and
   * must not be distinguishable from "not yours" by the caller.
   */
  abstract getOrder(
    accessToken: string,
    externalOrderId: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary | null>;

  /**
   * Every order the store holds for a phone number, most recent first. The
   * phone always comes from the platform's own `customers` row, never from a
   * tool argument.
   */
  abstract listOrdersByCustomerPhone(
    accessToken: string,
    customerPhone: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary[]>;

  /**
   * The secret this provider's webhook signature is actually computed with.
   * Salla signs with a per-connection secret the merchant configures; Zid
   * sends Basic-auth credentials whose password is the per-connection secret
   * we subscribed with; Shopify signs with the app's own API secret. Returning null means "no
   * secret available" and the caller MUST reject the webhook rather than
   * process it unverified.
   */
  abstract resolveWebhookSecret(connectionSecret: string | null): string | null;

  // Webhook verification
  abstract verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): boolean;

  /**
   * Provider-native event id, used for the (provider, store_id, event_id)
   * idempotency key. Null means the provider gave us nothing stable and the
   * caller falls back to a hash of the raw body.
   */
  abstract extractEventId(
    payload: unknown,
    headers: StoreWebhookHeaders,
  ): string | null;

  /**
   * Event normalization. Takes headers as well as the body because Shopify
   * puts the event topic in `x-shopify-topic`, not in the payload — the first
   * cut read a `topic` body field that Shopify never sends.
   */
  abstract normalizeWebhookEvent(
    payload: unknown,
    storeId: string,
    headers?: StoreWebhookHeaders,
  ): StoreWebhookEvent | null;
}

/**
 * Constant-time signature comparison that is also length-safe.
 * `crypto.timingSafeEqual` THROWS on length mismatch, so the first cut
 * (which called it on an attacker-controlled buffer) turned a forged
 * short signature into a 500 instead of a clean rejection.
 */
export function safeSignatureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
