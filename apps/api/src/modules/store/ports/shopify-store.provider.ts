// Feature 24 (Store Integrations): Shopify store adapter.
// Implements the StoreProvider abstract class for the Shopify e-commerce platform.
//
// Multi-merchant note: the shop domain is per-connection, not per-deployment.
// Every call takes it from the callback/connection context and only falls back
// to SHOPIFY_SHOP_DOMAIN (single-merchant dev setups) when none is supplied.
import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  StoreProvider,
  safeSignatureEqual,
  type StoreProduct,
  type StoreOrderResult,
  type StoreOrderStatus,
  type StoreOrderSummary,
  type StoreWebhookEvent,
  type StoreWebhookHeaders,
  type StoreOAuthCallbackContext,
  type StoreConnectionTokens,
  type StoreTokens,
} from './store-provider.port';
import { ORDER_HISTORY_LIMIT } from './rest-order-reader';
import { AppConfigService } from '../../core/config/app-config.service';
import { AppLoggerService } from '../../core';

/**
 * The one Admin API version every call is pinned to. Requests to a retired
 * version silently fall forward to the oldest accessible one, so this must
 * move forward every quarter (docs/integrations/SHOPIFY.md "Admin API version").
 */
export const SHOPIFY_ADMIN_API_VERSION = '2026-10';

/**
 * What the adapter reads and writes, and nothing more: no `write_products`
 * (we never write products). `read_customers` is what `Order.customer` and
 * `customers(query:)` need; `read_inventory` is what the
 * `inventory_levels/update` topic needs.
 */
export const SHOPIFY_SCOPES = [
  'read_products',
  'read_inventory',
  'read_orders',
  'read_customers',
  'write_draft_orders',
] as const;

/** The topics registered per shop after a connect (`webhookSubscriptionCreate`). */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'PRODUCTS_UPDATE',
  'INVENTORY_LEVELS_UPDATE',
  'ORDERS_CREATE',
  'APP_UNINSTALLED',
] as const;

/** Cap on Shopify error text copied into an exception or log line. */
const MAX_SHOPIFY_ERROR_LENGTH = 500;

/** The slices of Shopify's Admin GraphQL/REST responses this adapter relies on. */
interface GraphqlResponse<T> {
  data?: T;
  errors?: { message?: string }[];
}

interface ShopifyVariantNode {
  id?: string;
  sku?: string;
  price?: string | number;
  inventoryQuantity?: number;
  /** `tracked: false` = Shopify does not count this variant's inventory. */
  inventoryItem?: { tracked?: boolean };
}

interface ShopifyProductEdge {
  cursor: string;
  node: {
    id?: string;
    title?: string;
    featuredMedia?: {
      preview?: { image?: { url?: string } | null } | null;
    } | null;
    variants?: { edges?: { node?: ShopifyVariantNode }[] };
  };
}

interface ShopifyProductsData {
  shop?: { currencyCode?: string };
  products?: {
    edges?: ShopifyProductEdge[];
    pageInfo?: { hasNextPage?: boolean };
  };
}

interface ShopifyDraftOrderData {
  draftOrderCreate?: {
    draftOrder?: {
      id?: string;
      invoiceUrl?: string;
      totalPriceSet?: {
        shopMoney?: { amount?: string | number; currencyCode?: string };
      };
    };
    userErrors?: { field?: string[]; message?: string }[];
  };
}

/** The order fields ORDER_FIELDS below selects. Everything is optional: a shape change must degrade, not lie. */
interface ShopifyOrderNode {
  id?: string;
  name?: string;
  createdAt?: string;
  displayFulfillmentStatus?: string;
  cancelledAt?: string | null;
  phone?: string | null;
  totalPriceSet?: {
    shopMoney?: { amount?: string | number; currencyCode?: string };
  };
  customer?: {
    defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  } | null;
  shippingAddress?: { phone?: string | null } | null;
  fulfillments?: { trackingInfo?: { number?: string | null }[] }[];
  lineItems?: {
    edges?: {
      node?: {
        title?: string;
        quantity?: number;
        originalUnitPriceSet?: { shopMoney?: { amount?: string | number } };
      };
    }[];
  };
}

interface ShopifyOrderData {
  order?: ShopifyOrderNode | null;
}

interface ShopifyCustomerOrdersData {
  customers?: { nodes?: { orders?: { nodes?: ShopifyOrderNode[] } }[] };
}

interface ShopifyWebhookSubscriptionsData {
  webhookSubscriptions?: { nodes?: { topic?: string }[] };
}

interface ShopifyWebhookSubscriptionCreateData {
  webhookSubscriptionCreate?: {
    userErrors?: { field?: string[]; message?: string }[];
  };
}

interface ShopifyTokenResponse {
  access_token?: string;
  scope?: string;
}

interface ShopifyWebhookBody {
  id?: string | number;
  inventory_item_id?: string | number;
}

/** Shopify shop domains are `<name>.myshopify.com` — anything else is not a shop we will talk to. */
const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/** Selected once and reused by both order queries, so the two can never drift apart. */
const ORDER_FIELDS = `
  id
  name
  createdAt
  displayFulfillmentStatus
  cancelledAt
  phone
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { defaultPhoneNumber { phoneNumber } }
  shippingAddress { phone }
  fulfillments(first: 5) { trackingInfo { number } }
  lineItems(first: 20) {
    edges { node { title quantity originalUnitPriceSet { shopMoney { amount } } } }
  }
`;

/**
 * Shopify's fulfillment status → the platform's own order vocabulary, for all
 * 11 `OrderDisplayFulfillmentStatus` values. `cancelledAt` outranks it,
 * because a cancelled order keeps reporting `UNFULFILLED` and "pending" would
 * be a materially wrong answer. `OPEN`, `PENDING_FULFILLMENT` and `RESTOCKED`
 * are "replaced by" `UNFULFILLED` / `IN_PROGRESS` / `UNFULFILLED` and map the
 * same way; `RESTOCKED` means the items went back on the shelf, not a refund.
 */
function shopifyOrderStatus(node: ShopifyOrderNode): StoreOrderStatus {
  if (node.cancelledAt) return 'cancelled';
  switch (node.displayFulfillmentStatus) {
    case 'FULFILLED':
    case 'FULFILLMENT_NOT_REQUIRED':
      return 'completed';
    case 'IN_PROGRESS':
    case 'PENDING_FULFILLMENT':
    case 'PARTIALLY_FULFILLED':
    case 'SCHEDULED':
      return 'processing';
    case 'ON_HOLD':
    case 'REQUEST_DECLINED':
      return 'on_hold';
    case 'UNFULFILLED':
    case 'OPEN':
    case 'RESTOCKED':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** `+<digits>`: the E.164 form Shopify's `phone:` search and `MailingAddressInput.phone` take. Null when there are no digits. */
function toE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, '').replace(/^00/, '');
  return digits.length > 0 ? `+${digits}` : null;
}

/** First word → `firstName`, the rest → `lastName` (MailingAddressInput has no single name field). */
function splitName(name: string): { firstName?: string; lastName?: string } {
  const [first, ...rest] = name.trim().split(/\s+/);
  return {
    ...(first ? { firstName: first } : {}),
    ...(rest.length > 0 ? { lastName: rest.join(' ') } : {}),
  };
}

function toOrderSummary(node: ShopifyOrderNode): StoreOrderSummary {
  const money = node.totalPriceSet?.shopMoney ?? {};
  const placedAt = node.createdAt ? new Date(node.createdAt) : null;
  const tracking = node.fulfillments
    ?.flatMap((fulfillment) => fulfillment.trackingInfo ?? [])
    .map((info) => info.number)
    .find((number): number is string => !!number);

  return {
    externalId: (node.id ?? '').replace('gid://shopify/Order/', ''),
    orderNumber:
      node.name ?? (node.id ?? '').replace('gid://shopify/Order/', ''),
    status: shopifyOrderStatus(node),
    placedAt: placedAt && !Number.isNaN(placedAt.getTime()) ? placedAt : null,
    total: Number(money.amount ?? 0) || 0,
    // `shopMoney` is in the shop currency and `currencyCode` is non-null in
    // the schema; '' only marks a response that broke that contract.
    currency: money.currencyCode ?? '',
    customerPhone:
      node.phone ??
      node.customer?.defaultPhoneNumber?.phoneNumber ??
      node.shippingAddress?.phone ??
      null,
    trackingNumber: tracking ?? null,
    items: (node.lineItems?.edges ?? [])
      .map((edge) => edge.node)
      .filter((item): item is NonNullable<typeof item> => !!item)
      .map((item) => ({
        name: item.title ?? '',
        quantity: Number(item.quantity ?? 0) || 0,
        price: Number(item.originalUnitPriceSet?.shopMoney?.amount ?? 0) || 0,
      })),
  };
}

@Injectable()
export class ShopifyStoreProvider extends StoreProvider {
  readonly provider = 'shopify' as const;

  /** Shopify signs webhooks with HMAC-SHA256, base64-encoded, in this header. */
  readonly webhookSignatureHeader = 'x-shopify-hmac-sha256';

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  /**
   * Resolves and validates the shop domain. Validation matters because the
   * domain is interpolated into the URL we send the access token to — an
   * unvalidated `?shop=` param is a token-exfiltration primitive.
   */
  private shopDomain(context?: StoreOAuthCallbackContext): string {
    const raw = (context?.shop ?? this.config.shopifyShopDomain ?? '').trim();
    const domain = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!SHOP_DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid Shopify shop domain: ${raw || '(empty)'}`);
    }
    return domain;
  }

  /** Seals the validated shop into the connect state; the callback's `?shop=` is only cross-checked against it. */
  override connectBinding(
    context?: StoreOAuthCallbackContext,
  ): Pick<StoreOAuthCallbackContext, 'siteUrl' | 'shop'> {
    // Runs on the authenticated connect request, so a bad `?shop=` is the
    // caller's input error (400), not a server fault.
    try {
      return { shop: this.shopDomain(context) };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid Shopify shop domain',
      );
    }
  }

  getOAuthAuthorizeUrl(
    state: string,
    context?: StoreOAuthCallbackContext,
  ): string {
    const params = new URLSearchParams({
      client_id: this.config.shopifyClientId,
      redirect_uri: `${this.config.apiPublicBaseUrl}/store/callback/shopify`,
      scope: SHOPIFY_SCOPES.join(','),
      state,
    });
    return `https://${this.shopDomain(context)}/admin/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreConnectionTokens> {
    const shop = this.shopDomain(context);
    // Form-encoded with `Accept: application/json`, as every documented
    // example is. No `expiring=1`: custom-distribution apps keep
    // non-expiring offline tokens (expiring tokens are a TODOS.md item).
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.config.shopifyClientId,
        client_secret: this.config.shopifyClientSecret,
        code,
      }).toString(),
    });
    if (!res.ok)
      throw new Error(`Shopify token exchange failed: ${res.status}`);
    const data = (await res.json()) as ShopifyTokenResponse;
    if (!data.access_token) {
      throw new Error('Shopify token response contained no access_token');
    }
    this.warnOnMissingScopes(shop, data.scope);
    return {
      accessToken: data.access_token,
      storeId: shop,
      storeName: shop,
      storeUrl: `https://${shop}`,
    };
  }

  /**
   * The merchant can narrow scopes during authorization. A missing scope does
   * not fail the connect (the token still works for what was granted); it is
   * logged so the reads that will now come back empty or 403 are explainable.
   * A `write_x` grant covers `read_x`.
   */
  private warnOnMissingScopes(shop: string, granted: string | undefined): void {
    if (granted === undefined) return;
    const scopes = new Set(granted.split(',').map((scope) => scope.trim()));
    const missing = SHOPIFY_SCOPES.filter(
      (scope) =>
        !scopes.has(scope) &&
        !(
          scope.startsWith('read_') &&
          scopes.has(scope.replace(/^read_/, 'write_'))
        ),
    );
    if (missing.length > 0) {
      this.logger.warn(
        `Shopify shop ${shop} granted scope "${granted}" without required scope(s): ${missing.join(',')}`,
        'ShopifyStoreProvider',
      );
    }
  }

  /**
   * Shopify's callback `hmac`: hex HMAC-SHA256, keyed with the client secret,
   * over every OTHER query param sorted by key and joined as `k=v&k=v`
   * (docs/integrations/SHOPIFY.md, "Callback"). Any non-string value (a
   * repeated or nested param) fails: Shopify sends neither.
   */
  override verifyCallbackSignature(
    query: Readonly<Record<string, unknown>>,
  ): boolean {
    const secret = this.config.shopifyClientSecret;
    const hmac = query.hmac;
    if (!secret || typeof hmac !== 'string' || hmac.length === 0) return false;
    const entries = Object.entries(query).filter(([key]) => key !== 'hmac');
    if (entries.some(([, value]) => typeof value !== 'string')) return false;
    const message = entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value as string}`)
      .join('&');
    const expected = createHmac('sha256', secret).update(message).digest('hex');
    return safeSignatureEqual(hmac, expected);
  }

  /**
   * Shop-specific subscriptions (`webhookSubscriptionCreate`, `uri` field) to
   * `/store/webhook/shopify/<shop>`, the route that resolves the connection
   * from the path. Topics already subscribed to that exact URI are skipped,
   * so a reconnect does not pile up duplicates. One topic failing does not
   * stop the others; the caller logs a throw and keeps the connection.
   */
  override async registerWebhooks(
    accessToken: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<void> {
    const shop = this.shopDomain(context);
    const uri = `${this.config.apiPublicBaseUrl}/store/webhook/shopify/${shop}`;
    const existing = await this.graphql<ShopifyWebhookSubscriptionsData>(
      accessToken,
      `query webhookSubscriptions($uri: String!) {
        webhookSubscriptions(first: 50, uri: $uri) { nodes { topic } }
      }`,
      { uri },
      context,
    );
    const subscribed = new Set(
      (existing.data?.webhookSubscriptions?.nodes ?? []).map(
        (node) => node.topic,
      ),
    );
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      if (subscribed.has(topic)) continue;
      const created = await this.graphql<ShopifyWebhookSubscriptionCreateData>(
        accessToken,
        `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
              webhookSubscription { id }
              userErrors { field message }
            }
          }`,
        { topic, webhookSubscription: { uri, format: 'JSON' } },
        context,
      );
      const userErrors = created.data?.webhookSubscriptionCreate?.userErrors;
      if (userErrors && userErrors.length > 0) {
        this.logger.warn(
          `Shopify webhook ${topic} not registered for ${shop}: ${JSON.stringify(userErrors).slice(0, MAX_SHOPIFY_ERROR_LENGTH)}`,
          'ShopifyStoreProvider',
        );
      }
    }
  }

  /**
   * Shopify offline access tokens do not expire and have no refresh grant —
   * null tells the caller "keep using the stored token". (The first cut called
   * exchangeCode() with the refresh token, which Shopify would reject.)
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async refreshAccessToken(): Promise<StoreTokens | null> {
    return null;
  }

  async listProducts(
    accessToken: string,
    after?: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<{
    products: StoreProduct[];
    hasNextPage: boolean;
    nextCursor?: string;
  }> {
    const query = `
      query products($after: String) {
        shop { currencyCode }
        products(first: 50, after: $after, query: "status:active") {
          edges {
            cursor
            node {
              id
              title
              featuredMedia { preview { image { url } } }
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    price
                    inventoryQuantity
                    inventoryItem { tracked }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;
    const data = await this.graphql<ShopifyProductsData>(
      accessToken,
      query,
      { after: after ?? null },
      context,
    );
    const edges = data.data?.products?.edges ?? [];
    // Selected in the same request as the page, so it costs no extra call.
    // `ProductVariant.price` is in this currency.
    const currency = data.data?.shop?.currencyCode ?? '';
    return {
      products: edges.map((edge) => {
        const node = edge.node;
        const variant = node.variants?.edges?.[0]?.node ?? {};
        // Untracked inventory has no meaningful count: stock null, in stock.
        const untracked = variant.inventoryItem?.tracked === false;
        const stock = untracked ? null : Number(variant.inventoryQuantity ?? 0);
        return {
          externalId: (node.id ?? '').replace('gid://shopify/Product/', ''),
          name: node.title ?? '',
          price: Number(variant.price ?? 0),
          currency,
          stock,
          stockStatus:
            stock === null || stock > 0
              ? ('in_stock' as const)
              : ('out_of_stock' as const),
          imageUrl: node.featuredMedia?.preview?.image?.url ?? undefined,
          sku: variant.sku,
          metadata: {
            shopifyVariantId: variant.id
              ? variant.id.replace('gid://shopify/ProductVariant/', '')
              : undefined,
          },
        };
      }),
      hasNextPage: data.data?.products?.pageInfo?.hasNextPage ?? false,
      nextCursor: edges.length > 0 ? edges[edges.length - 1].cursor : undefined,
    };
  }

  async createOrder(
    accessToken: string,
    order: {
      customerId?: string;
      customerPhone: string;
      customerName: string;
      shippingAddress: string;
      items: {
        productId: string;
        variantId?: string;
        quantity: number;
        price: number;
      }[];
      notes?: string;
    },
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderResult> {
    const draftOrderMutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
          userErrors { field message }
        }
      }
    `;
    // `DraftOrderLineItemInput.variantId` must be a variant id. A product id
    // wrapped in a ProductVariant GID (the old fallback) is a different
    // object, so a line with no synced variant fails here, before any call.
    const missingVariant = order.items.find((item) => !item.variantId);
    if (missingVariant) {
      throw new Error(
        `Shopify order needs a variant id for every line item; product ${missingVariant.productId} has none (re-sync the catalogue)`,
      );
    }
    const phone = toE164(order.customerPhone);
    // The address is one free-text line: it goes in `address1`. No
    // `countryCode`/`city` is held, so Shopify may not compute shipping/tax.
    const input = {
      note: order.notes,
      ...(phone ? { phone } : {}),
      shippingAddress: {
        address1: order.shippingAddress,
        ...splitName(order.customerName),
        ...(phone ? { phone } : {}),
      },
      lineItems: order.items.map((i) => ({
        variantId: `gid://shopify/ProductVariant/${i.variantId}`,
        quantity: i.quantity,
      })),
    };
    const data = await this.graphql<ShopifyDraftOrderData>(
      accessToken,
      draftOrderMutation,
      { input },
      context,
    );
    const draft = data.data?.draftOrderCreate?.draftOrder;
    if (!draft) {
      throw new Error(
        `Shopify order creation failed: ${JSON.stringify(data.data?.draftOrderCreate?.userErrors ?? data.errors)}`,
      );
    }
    const money = draft.totalPriceSet?.shopMoney ?? {};
    return {
      orderId: (draft.id ?? '').replace('gid://shopify/DraftOrder/', ''),
      paymentUrl: draft.invoiceUrl ?? '',
      total: Number(money.amount ?? 0),
      currency: money.currencyCode ?? '',
    };
  }

  getOrder(
    accessToken: string,
    externalOrderId: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary | null> {
    return this.readOrder(accessToken, externalOrderId, context);
  }

  private async readOrder(
    accessToken: string,
    externalOrderId: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary | null> {
    const data = await this.graphql<ShopifyOrderData>(
      accessToken,
      `query order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
      { id: `gid://shopify/Order/${externalOrderId}` },
      context,
    );
    const node = data.data?.order;
    return node ? toOrderSummary(node) : null;
  }

  async listOrdersByCustomerPhone(
    accessToken: string,
    customerPhone: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary[]> {
    // `orders(query:)` has no `phone` filter, and Shopify IGNORES an invalid
    // search field and returns every order. `customers(query:)` does have
    // one, so the documented route is customer-by-phone → their orders.
    // The phone is reduced to `+<digits>` (nothing else can reach the search
    // string). As with every adapter here, the search only narrows:
    // StoreOrderLookupService re-checks ownership before returning anything.
    // Guest-checkout orders with no Customer record are not found this way.
    const phone = toE164(customerPhone);
    if (!phone) return [];
    const data = await this.graphql<ShopifyCustomerOrdersData>(
      accessToken,
      `query customerOrders($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            orders(first: ${ORDER_HISTORY_LIMIT}, sortKey: CREATED_AT, reverse: true) {
              nodes { ${ORDER_FIELDS} }
            }
          }
        }
      }`,
      { query: `phone:${phone}` },
      context,
    );
    return (data.data?.customers?.nodes ?? [])
      .flatMap((customer) => customer.orders?.nodes ?? [])
      .map(toOrderSummary);
  }

  private async graphql<T>(
    accessToken: string,
    query: string,
    variables: Record<string, unknown>,
    context?: StoreOAuthCallbackContext,
  ): Promise<GraphqlResponse<T>> {
    const res = await fetch(
      `https://${this.shopDomain(context)}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (!res.ok) throw new Error(`Shopify API call failed: ${res.status}`);
    const body = (await res.json()) as GraphqlResponse<T>;
    // Scope and protected-customer-data refusals come back as HTTP 200 with
    // the fields nulled and an `errors` entry. Returning `data` alone read
    // them as "no orders" / "not found", so any top-level error throws.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const messages = body.errors
        .map((error) => error.message ?? 'unknown error')
        .join('; ');
      throw new Error(
        `Shopify GraphQL error: ${messages.slice(0, MAX_SHOPIFY_ERROR_LENGTH)}`,
      );
    }
    return body;
  }

  /**
   * Shopify webhooks are signed with the APP's API secret, not a per-shop
   * secret — so the per-connection column is irrelevant here and the config
   * value is the real source. Returns null (=> reject) when unconfigured.
   */
  resolveWebhookSecret(): string | null {
    const secret = this.config.shopifyClientSecret;
    return secret && secret.length > 0 ? secret : null;
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): boolean {
    const expected = createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('base64');
    return safeSignatureEqual(signature, expected);
  }

  extractEventId(
    _payload: unknown,
    headers: StoreWebhookHeaders,
  ): string | null {
    const id = headers['x-shopify-webhook-id'];
    return id && id.length > 0 ? id : null;
  }

  normalizeWebhookEvent(
    payload: unknown,
    storeId: string,
    headers?: StoreWebhookHeaders,
  ): StoreWebhookEvent | null {
    const data = (payload ?? {}) as ShopifyWebhookBody;
    const body = data as Record<string, unknown>;
    const topic = headers?.['x-shopify-topic'];
    if (!topic) return null;
    const productId = data.id === undefined ? '' : String(data.id);
    if (topic === 'orders/create') {
      return {
        eventType: 'order_created',
        externalId: productId,
        storeId,
        payload: body,
      };
    }
    if (topic === 'products/update') {
      return {
        eventType: 'product_updated',
        externalId: productId,
        storeId,
        payload: body,
      };
    }
    if (topic === 'inventory_levels/update') {
      // Not `stock_changed`: the payload names an inventory item (not the
      // product id the catalogue is keyed on) and `available` is ONE
      // location's count, not the variant total. Applying it would write a
      // wrong number even if the id matched, so the connection is re-synced.
      return {
        eventType: 'inventory_changed',
        externalId:
          data.inventory_item_id === undefined
            ? ''
            : String(data.inventory_item_id),
        storeId,
        payload: body,
      };
    }
    if (topic === 'app/uninstalled') {
      return {
        eventType: 'app_uninstalled',
        externalId: '',
        storeId,
        payload: body,
      };
    }
    return { eventType: 'unknown', externalId: '', storeId, payload: body };
  }
}
