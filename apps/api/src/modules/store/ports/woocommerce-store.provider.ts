// Feature 24 (Store Integrations): WooCommerce store adapter.
//
// WooCommerce is NOT like the other three, and this adapter models the
// difference rather than pretending it away:
//
//  1. There is no hosted platform. Every WooCommerce merchant is a
//     self-hosted WordPress site, so "which host do we talk to" is per
//     connection (`StoreOAuthCallbackContext.siteUrl`, falling back to
//     `shop`, which is where `store_connections.store_id` lands). A
//     deployment-wide `WOOCOMMERCE_SITE_URL` would cap this platform at one
//     merchant, exactly the bug the Shopify adapter's header comment records.
//
//  2. There is no OAuth server and no access token. The merchant-facing flow
//     is WooCommerce's own key-exchange endpoint, `/wc-auth/v1/authorize`:
//     we send the merchant to their own site, they approve, and the SITE then
//     makes a server-to-server POST to our `callback_url` carrying a
//     permanent `consumer_key` / `consumer_secret` pair. There is no
//     authorization code, no token endpoint, and nothing to refresh.
//     `exchangeCode()` therefore takes the credential pair the callback
//     delivered, encoded as `consumer_key:consumer_secret`, and
//     `refreshAccessToken()` returns null (no refresh grant exists) — the
//     same honest null Shopify's offline tokens return.
//     The stored `accessToken` is that pair; every API call sends it as HTTP
//     Basic, which is WooCommerce's documented scheme over HTTPS. It is
//     AES-256-GCM at rest like every other provider's token because
//     `StoreConnectionService` encrypts the column, not the adapter.
//
//  3. `/wc-auth/v1/authorize` has no `state` parameter. Its `user_id` field
//     is an opaque value the site echoes back verbatim in the callback POST,
//     so the signed state rides there — the state is still HMAC-signed and
//     still the only thing that names a tenant, which is the property the
//     F24 review made non-negotiable.
//
// UNVERIFIABLE WITHOUT A LIVE SITE, stated rather than hidden: no call has
// ever been made from this repo to a real WooCommerce install. The endpoint
// paths, the callback body's field names, the `x-wc-webhook-*` header set and
// the order/product field names below are taken from WooCommerce's published
// REST API v3 and Auth API v1 documentation. What cannot be checked without a
// live site is (a) whether a given install is behind a security plugin that
// strips the Authorization header (a known WooCommerce deployment hazard for
// which the vendor documents a query-string key/secret fallback we do NOT
// implement, because it puts the secret in access logs), (b) the exact
// `date_created` timezone semantics, and (c) that the site's permalinks are
// configured such that `/wp-json/wc/v3` resolves at all. Each of those is a
// merchant-side configuration failure that surfaces as a non-2xx and is
// reported as such; none of them can be papered over here.
import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  StoreProvider,
  safeSignatureEqual,
  type StoreProduct,
  type StoreOrderResult,
  type StoreOrderSummary,
  type StoreWebhookEvent,
  type StoreWebhookHeaders,
  type StoreOAuthCallbackContext,
  type StoreConnectionTokens,
  type StoreTokens,
} from './store-provider.port';
import {
  idOf,
  resolveNames,
  restOrderToSummary,
  type RestOrderPayload,
  type RestProductPayload,
} from './store-api-types';
import {
  listRestOrdersByPhone,
  readRestOrder,
  type RestOrderReadOptions,
} from './rest-order-reader';
import { AppConfigService } from '../../core/config/app-config.service';

/** WooCommerce product payloads carry stock in their own fields, not the shared `stock`. */
interface WooProductPayload extends RestProductPayload {
  /** False when the merchant switched stock management off; the quantity is then null. */
  manage_stock?: boolean;
  stock_quantity?: number | string | null;
  stock_status?: string;
  regular_price?: string;
  images?: string[];
  categories?: { name?: string }[];
}

interface WooOrderCreateResponse extends RestOrderPayload {
  payment_url?: string;
}

/**
 * A site origin we are willing to talk to. Hostname-only, https-only: the
 * value is interpolated into every URL we send the merchant's credentials to,
 * so an unvalidated one is a credential-exfiltration primitive — the same
 * reasoning behind the Shopify adapter's domain pattern.
 */
const SITE_HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;

/** WooCommerce webhook topics we act on; everything else normalizes to `unknown`. */
const WEBHOOK_TOPICS: Readonly<Record<string, StoreWebhookEvent['eventType']>> =
  {
    'order.created': 'order_created',
    'product.created': 'product_updated',
    'product.updated': 'product_updated',
    'product.restored': 'product_updated',
  };

@Injectable()
export class WooCommerceStoreProvider extends StoreProvider {
  readonly provider = 'woocommerce' as const;

  /** WooCommerce signs webhooks with base64 HMAC-SHA256 over the raw body in this header. */
  readonly webhookSignatureHeader = 'x-wc-webhook-signature';

  constructor(private readonly config: AppConfigService) {
    super();
  }

  /**
   * Resolves and validates the merchant's own site host. `siteUrl` is the
   * explicit carrier; `shop` is the fallback because existing call sites
   * (sync, order creation) pass `store_connections.store_id` there, and for
   * WooCommerce that column holds the host.
   */
  private siteHost(context?: StoreOAuthCallbackContext): string {
    const raw = (context?.siteUrl ?? context?.shop ?? '').trim();
    const host = raw
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .split('/')[0];
    if (!SITE_HOST_PATTERN.test(host)) {
      throw new Error(`Invalid WooCommerce site: ${raw || '(empty)'}`);
    }
    return host;
  }

  private apiBase(context?: StoreOAuthCallbackContext): string {
    return `https://${this.siteHost(context)}/wp-json/wc/v3`;
  }

  /** `consumer_key:consumer_secret` as HTTP Basic, WooCommerce's documented scheme for HTTPS sites. */
  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(accessToken, 'utf8').toString('base64')}`,
    };
  }

  private readOptions(
    accessToken: string,
    context?: StoreOAuthCallbackContext,
  ): RestOrderReadOptions {
    return {
      provider: 'WooCommerce',
      baseUrl: this.apiBase(context),
      headers: this.authHeaders(accessToken),
      // WooCommerce stores are multi-currency across merchants; the payload's
      // own `currency` wins and this is only the "payload said nothing" case.
      fallbackCurrency: 'SAR',
    };
  }

  /**
   * The key-exchange URL. `state` rides in `user_id` because `/wc-auth` has
   * no state parameter of its own and echoes `user_id` back verbatim in the
   * callback POST.
   */
  getOAuthAuthorizeUrl(
    state: string,
    context?: StoreOAuthCallbackContext,
  ): string {
    const params = new URLSearchParams({
      app_name: this.config.woocommerceAppName,
      scope: 'read_write',
      user_id: state,
      return_url: `${this.config.consoleBaseUrl}/stores?connected=pending`,
      callback_url: this.config.woocommerceCallbackUrl,
    });
    return `https://${this.siteHost(context)}/wc-auth/v1/authorize?${params.toString()}`;
  }

  /**
   * No network call: WooCommerce already handed us the permanent credential
   * pair in the callback body, so "exchange" is validation and shaping only.
   * `code` is `consumer_key:consumer_secret`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async exchangeCode(
    code: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreConnectionTokens> {
    const separator = code.indexOf(':');
    const consumerKey = separator < 0 ? '' : code.slice(0, separator);
    const consumerSecret = separator < 0 ? '' : code.slice(separator + 1);
    if (!consumerKey || !consumerSecret) {
      throw new Error(
        'WooCommerce callback did not carry a consumer_key/consumer_secret pair',
      );
    }
    const host = this.siteHost(context);
    return {
      accessToken: `${consumerKey}:${consumerSecret}`,
      storeId: host,
      storeName: host,
      storeUrl: `https://${host}`,
    };
  }

  /** WooCommerce API keys are permanent and have no refresh grant — null means "keep using the stored credential". */
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
    const page = after ? Number(after) : 1;
    const res = await fetch(
      `${this.apiBase(context)}/products?page=${page}&per_page=50`,
      { headers: this.authHeaders(accessToken) },
    );
    if (!res.ok) {
      throw new Error(`WooCommerce products list failed: ${res.status}`);
    }
    // WooCommerce returns a bare array plus an `X-WP-TotalPages` header —
    // there is no envelope and no cursor, so pagination is page-number based.
    const payload = (await res.json()) as WooProductPayload[];
    const totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1');
    const hasNextPage = Number.isFinite(totalPages) && page < totalPages;

    return {
      products: (Array.isArray(payload) ? payload : []).map((product) => {
        const untracked =
          product.manage_stock === false ||
          product.stock_quantity === null ||
          product.stock_quantity === undefined;
        const stock = untracked ? null : Number(product.stock_quantity) || 0;
        const { name, nameAr } = resolveNames(product);
        return {
          externalId: idOf(product.id),
          name,
          nameAr,
          price: Number(product.price ?? product.regular_price ?? 0) || 0,
          currency: 'SAR',
          stock,
          // `stock_status` is authoritative on WooCommerce: a product with
          // stock management switched off reports quantity null (stock null
          // here, "not tracked") but is still purchasable, and treating that
          // as out_of_stock would silently hide the merchant's whole catalogue.
          stockStatus: this.stockStatusOf(product, stock),
          imageUrl: product.images?.[0],
          sku: product.sku,
          category: product.categories?.[0]?.name,
          metadata: {},
        };
      }),
      hasNextPage,
      nextCursor: hasNextPage ? String(page + 1) : undefined,
    };
  }

  private stockStatusOf(
    product: WooProductPayload,
    stock: number | null,
  ): StoreProduct['stockStatus'] {
    switch (product.stock_status) {
      case 'outofstock':
        return 'out_of_stock';
      case 'onbackorder':
        return 'pre_order';
      case 'instock':
        return 'in_stock';
      default:
        return stock === null || stock > 0 ? 'in_stock' : 'out_of_stock';
    }
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
    const res = await fetch(`${this.apiBase(context)}/orders`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Phase 1 is COD everywhere (F25 D-payment), so the order is created
        // unpaid and the merchant's own WooCommerce flow takes it from here.
        payment_method: 'cod',
        payment_method_title: 'Cash on delivery',
        set_paid: false,
        billing: {
          first_name: order.customerName,
          phone: order.customerPhone,
          address_1: order.shippingAddress,
        },
        shipping: {
          first_name: order.customerName,
          address_1: order.shippingAddress,
        },
        customer_note: order.notes,
        line_items: order.items.map((item) => ({
          product_id: Number(item.productId),
          ...(item.variantId ? { variation_id: Number(item.variantId) } : {}),
          quantity: item.quantity,
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`WooCommerce order creation failed: ${res.status}`);
    }
    const data = (await res.json()) as WooOrderCreateResponse;
    if (data.id === undefined) {
      throw new Error('WooCommerce order creation returned no order id');
    }
    const summary = restOrderToSummary(data, 'SAR');
    return {
      orderId: summary.externalId,
      // WooCommerce's own field for the hosted pay page. COD orders have none.
      paymentUrl: data.payment_url ?? '',
      total: summary.total,
      currency: summary.currency,
    };
  }

  getOrder(
    accessToken: string,
    externalOrderId: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary | null> {
    return readRestOrder(
      this.readOptions(accessToken, context),
      externalOrderId,
    );
  }

  listOrdersByCustomerPhone(
    accessToken: string,
    customerPhone: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary[]> {
    // WooCommerce core's /orders has no phone filter; `search` matches the
    // billing phone among other billing fields. Results are therefore a
    // SUPERSET and are re-checked against the caller's own phone by
    // StoreOrderLookupService before anything is returned — the filter is a
    // narrowing convenience, never the authorization.
    return listRestOrdersByPhone(
      this.readOptions(accessToken, context),
      'search',
      customerPhone,
    );
  }

  /** Per-connection secret (the merchant pastes it into WooCommerce's webhook settings). */
  resolveWebhookSecret(connectionSecret: string | null): string | null {
    return connectionSecret && connectionSecret.length > 0
      ? connectionSecret
      : null;
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

  /** WooCommerce's per-delivery id header — a retry of the same delivery reuses it, which is exactly the idempotency key. */
  extractEventId(
    _payload: unknown,
    headers: StoreWebhookHeaders,
  ): string | null {
    const deliveryId = headers['x-wc-webhook-delivery-id'];
    if (deliveryId && deliveryId.length > 0) return deliveryId;
    const topic = headers['x-wc-webhook-topic'];
    const resourceId = headers['x-wc-webhook-resource-id'];
    return topic && resourceId ? `${topic}:${resourceId}` : null;
  }

  /** The topic is a header, never a body field — same shape as Shopify, not as Salla/Zid. */
  normalizeWebhookEvent(
    payload: unknown,
    storeId: string,
    headers?: StoreWebhookHeaders,
  ): StoreWebhookEvent | null {
    const topic = headers?.['x-wc-webhook-topic'];
    if (!topic) return null;
    const body = (payload ?? {}) as Record<string, unknown> & {
      id?: string | number;
    };
    const eventType = WEBHOOK_TOPICS[topic];
    if (!eventType) {
      return { eventType: 'unknown', externalId: '', storeId, payload: body };
    }
    return {
      eventType,
      externalId: idOf(body.id),
      storeId,
      payload: body,
    };
  }
}
