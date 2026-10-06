// Feature 24 (Store Integrations): Zid store adapter.
// Implements the StoreProvider abstract class for the Zid e-commerce platform.
//
// Every endpoint, header and field here follows docs/integrations/ZID.md
// (docs.zid.sa + Zid's official express-sample-app, read 2026-10-03). Nothing
// has been run against a live Zid store: there is no Zid app or credentials
// yet. Anything the docs do not state is marked UNVERIFIED here and there.
//
// Zid issues TWO tokens and every Merchant API call needs both:
//   Authorization: Bearer <authorization>   (partner token)
//   X-Manager-Token: <access_token>         (manager token)
// Product endpoints take the manager token as `Access-Token` instead, plus
// `Store-Id` and `Role: Manager`. The partner token reaches this adapter as
// `context.authorizationToken`, the numeric store id as `context.shop`.
import { Injectable } from '@nestjs/common';
import {
  StoreProvider,
  safeSignatureEqual,
  type StoreProduct,
  type StoreOrderResult,
  type StoreOrderSummary,
  type StoreWebhookEvent,
  type StoreWebhookRegistration,
  type StoreConnectionTokens,
  type StoreOAuthCallbackContext,
  type StoreTokens,
} from './store-provider.port';
import { expiryFrom, idOf, requireAccessToken } from './store-api-types';
import {
  zidAuthorizationToken,
  zidBasicAuthHeader,
  zidErrorDetail,
  zidOrderToSummary,
  zidProductToStoreProduct,
  type ZidOrderListResponse,
  type ZidOrderViewResponse,
  type ZidProductListResponse,
  type ZidProfileResponse,
  type ZidTokenResponse,
  type ZidWebhookPayload,
} from './zid-api-types';
import { ORDER_HISTORY_LIMIT } from './rest-order-reader';
import { AppConfigService } from '../../core/config/app-config.service';
import { AppLoggerService } from '../../core';

const API_BASE_URL = 'https://api.zid.sa/v1';
const OAUTH_BASE_URL = 'https://oauth.zid.sa';

/** Products requested per page on catalogue sync. Zid's default is 10; no maximum is documented (UNVERIFIED that 50 is accepted). */
const PRODUCTS_PER_PAGE = 50;

/** Used only when a payload carries no currency. */
const FALLBACK_CURRENCY = 'SAR';

/**
 * Store events subscribed on connect. `order.payment_status.update` and
 * `product.publish` are normalized if they arrive but are not subscribed:
 * nothing acts on them yet.
 */
export const ZID_WEBHOOK_EVENTS = [
  'order.create',
  'order.status.update',
  'product.create',
  'product.update',
  'product.delete',
] as const;

/**
 * Basic-auth username we subscribe with. The per-connection webhook secret is
 * the password, so the username carries no secret and can be constant.
 */
export const ZID_WEBHOOK_USERNAME = 'clarly';

/** Zid event name → platform event. Anything else normalizes to `unknown`. */
const ZID_EVENT_TYPES: Readonly<
  Record<string, StoreWebhookEvent['eventType']>
> = {
  'order.create': 'order_created',
  'order.status.update': 'order_updated',
  'order.payment_status.update': 'order_updated',
  // Zid has no stock event: stock moves (if at all) arrive as product.update.
  'product.create': 'product_updated',
  'product.update': 'product_updated',
  'product.publish': 'product_updated',
  'product.delete': 'product_updated',
  // App Market event. Zid sends these to the ONE endpoint configured in the
  // Partner Dashboard, not to the per-store route this adapter subscribes,
  // so today it only lands here if that routing gap is closed (TODOS.md).
  'app.market.application.uninstall': 'app_uninstalled',
};

/**
 * Rate limit: 60 requests / minute per app per store (leaky bucket). A 429 is
 * retried after `Retry-After` when Zid sends it (UNVERIFIED that it does),
 * else after an exponential backoff.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const MAX_RATE_LIMIT_DELAY_MS = 30_000;

/** Zid order ids are integers (View Order docs); anything else cannot be one. */
const ORDER_ID_PATTERN = /^\d+$/;

/**
 * Thrown before any call when an order cannot be expressed in Zid's Create
 * Order body without inventing data. Not a transient failure.
 */
export class ZidOrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZidOrderInputError';
  }
}

type Headers = Record<string, string>;

@Injectable()
export class ZidStoreProvider extends StoreProvider {
  readonly provider = 'zid' as const;

  /**
   * Zid authenticates deliveries with HTTP Basic credentials we choose when
   * subscribing (`Authorization: Basic base64(user:pass)`). There is no body
   * signature.
   */
  readonly webhookSignatureHeader = 'authorization';

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  // ---- OAuth ----

  /** No `scope`: Zid scopes are chosen on the app in the Partner Dashboard. */
  getOAuthAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.zidClientId,
      redirect_uri: this.config.zidRedirectUri,
      response_type: 'code',
      state,
    });
    return `${OAUTH_BASE_URL}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<StoreConnectionTokens> {
    const data = await this.tokenRequest(
      { grant_type: 'authorization_code', code },
      'token exchange',
    );
    const accessToken = requireAccessToken('Zid', data);
    const authorizationToken = zidAuthorizationToken(data);
    if (!authorizationToken) {
      throw new Error('Zid token response contained no authorization token');
    }
    // The token response carries no store identity; the profile does.
    const store = await this.fetchStore(accessToken, authorizationToken);
    return {
      accessToken,
      authorizationToken,
      refreshToken: data.refresh_token,
      expiresAt: expiryFrom(data),
      ...store,
    };
  }

  /**
   * `grant_type=refresh_token`, with `redirect_uri` as the docs' example sends
   * it. Whether Zid rotates `refresh_token` / `authorization` here is
   * UNVERIFIED, so whatever comes back is kept and the rest stays stored.
   */
  async refreshAccessToken(refreshToken: string): Promise<StoreTokens> {
    const data = await this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'token refresh',
    );
    return {
      accessToken: requireAccessToken('Zid', data),
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: expiryFrom(data),
      authorizationToken: zidAuthorizationToken(data),
    };
  }

  /** Body parameters, form-encoded (the docs' cURL/Python examples). */
  private async tokenRequest(
    params: Record<string, string>,
    label: string,
  ): Promise<ZidTokenResponse> {
    const res = await this.request(`${OAUTH_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.zidClientId,
        client_secret: this.config.zidClientSecret,
        redirect_uri: this.config.zidRedirectUri,
        ...params,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Zid ${label} failed: ${res.status}`);
    return (await res.json()) as ZidTokenResponse;
  }

  /** `GET /managers/account/profile` → `user.store.{id,title,url}`. */
  private async fetchStore(
    accessToken: string,
    authorizationToken: string,
  ): Promise<{ storeId: string; storeName: string; storeUrl?: string }> {
    const res = await this.request(`${API_BASE_URL}/managers/account/profile`, {
      headers: this.managerHeaders(accessToken, { authorizationToken }),
    });
    if (!res.ok) throw new Error(`Zid profile read failed: ${res.status}`);
    const store = ((await res.json()) as ZidProfileResponse).user?.store;
    const storeId = idOf(store?.id);
    // An empty storeId would collide every Zid connection on one key and
    // break the webhook route, which is keyed on it.
    if (storeId.length === 0) {
      throw new Error('Zid profile returned no store id');
    }
    return {
      storeId,
      storeName: store?.title || 'Zid Store',
      storeUrl: store?.url || undefined,
    };
  }

  // ---- Catalogue ----

  /** `GET /products/`, Django-style pages: more exist while `next` is set. */
  async listProducts(
    accessToken: string,
    after?: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<{
    products: StoreProduct[];
    hasNextPage: boolean;
    nextCursor?: string;
  }> {
    const page = pageNumber(after);
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(PRODUCTS_PER_PAGE),
      is_published: 'true',
    });
    const res = await this.request(
      `${API_BASE_URL}/products/?${params.toString()}`,
      { headers: this.productHeaders(accessToken, context) },
    );
    if (!res.ok) throw new Error(`Zid products list failed: ${res.status}`);
    const data = (await res.json()) as ZidProductListResponse;
    const hasNextPage = Boolean(data.next);
    return {
      products: (data.results ?? [])
        .filter((product) => Boolean(product.id))
        .map((product) => zidProductToStoreProduct(product, FALLBACK_CURRENCY)),
      hasNextPage,
      nextCursor: hasNextPage ? String(page + 1) : undefined,
    };
  }

  // ---- Orders ----

  /**
   * Zid's Create Order (`POST /managers/store/drafts`) requires fields the
   * platform's order does not carry: `shipping_method {type, id}` (a store
   * delivery option), a structured `consignee.address` (`line_1`, `line_2`,
   * `city_name`, ISO `country_code`), `customer.email` (Create Order lists it
   * as required; Validate Order says it may be null — UNVERIFIED), products
   * by `sku`, and a ZidPay payment-link `payment_method.id`. Filling them
   * would mean inventing a shipping method and an address, so this refuses
   * before calling Zid. The push records the failure and the merchant is
   * told to enter the order by hand. See TODOS.md for the unblock gate.
   */
  createOrder(): Promise<StoreOrderResult> {
    return Promise.reject(
      new ZidOrderInputError(
        'Zid order creation is not supported yet: Zid requires a shipping method, a structured delivery address and a customer email, which this order does not have',
      ),
    );
  }

  /**
   * `GET /managers/store/orders/{id}/view` → `{ order }`. Null for a
   * reference that cannot be a Zid order id, and for a 404 (Zid does not
   * document its not-found status for this route; UNVERIFIED).
   */
  async getOrder(
    accessToken: string,
    externalOrderId: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary | null> {
    const orderId = externalOrderId.trim();
    if (!ORDER_ID_PATTERN.test(orderId)) return null;
    const res = await this.request(
      `${API_BASE_URL}/managers/store/orders/${orderId}/view`,
      { headers: this.managerHeaders(accessToken, context) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Zid order read failed: ${res.status}`);
    const order = ((await res.json()) as ZidOrderViewResponse).order;
    if (order?.id === undefined || order.id === null) return null;
    return zidOrderToSummary(order, FALLBACK_CURRENCY);
  }

  /**
   * `GET /managers/store/orders?search_term=<phone>` → `{ orders }`, newest
   * first. `search_term` also matches email, order code and customer name, so
   * it only narrows: StoreOrderLookupService's phone check is what decides
   * whose orders these are. `payload_type=default` includes the products.
   */
  async listOrdersByCustomerPhone(
    accessToken: string,
    customerPhone: string,
    context?: StoreOAuthCallbackContext,
  ): Promise<StoreOrderSummary[]> {
    // The docs' example search term is `966500000005`: digits, no `+`.
    const searchTerm = customerPhone.replace(/\D/g, '').replace(/^00/, '');
    if (searchTerm.length === 0) return [];
    const params = new URLSearchParams({
      search_term: searchTerm,
      page: '1',
      per_page: String(ORDER_HISTORY_LIMIT),
      payload_type: 'default',
      order_by: 'created_at',
      sort_by: 'desc',
    });
    const res = await this.request(
      `${API_BASE_URL}/managers/store/orders?${params.toString()}`,
      { headers: this.managerHeaders(accessToken, context) },
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Zid order list failed: ${res.status}`);
    const data = (await res.json()) as ZidOrderListResponse;
    return (data.orders ?? [])
      .map((order) => zidOrderToSummary(order, FALLBACK_CURRENCY))
      .slice(0, ORDER_HISTORY_LIMIT);
  }

  // ---- Webhooks ----

  /**
   * Subscribes ZID_WEBHOOK_EVENTS to `/store/webhook/zid/<storeId>` with
   * Basic-auth credentials (password = the connection's webhook secret).
   * Any subscriptions this app already has on the store are deleted first:
   * a reconnect mints a new secret, and a subscription still carrying the old
   * password would be rejected on every delivery. Throws when any event
   * failed so the OAuth service can log and surface it; the connection is
   * kept either way.
   */
  override async registerWebhooks(
    accessToken: string,
    context?: StoreOAuthCallbackContext,
    registration?: StoreWebhookRegistration,
  ): Promise<void> {
    if (!registration) {
      throw new Error(
        'Zid webhook registration needs the store id and webhook secret',
      );
    }
    const appId = this.config.zidAppId;
    if (!appId) {
      throw new Error('ZID_APP_ID is not set; no Zid webhooks were subscribed');
    }
    const publicBaseUrl = this.config.apiPublicBaseUrl;
    if (!publicBaseUrl) {
      throw new Error(
        'API_PUBLIC_BASE_URL is not set; no Zid webhooks were subscribed',
      );
    }

    const headers = {
      ...this.managerHeaders(accessToken, context),
      'Content-Type': 'application/json',
    };
    await this.deleteSubscriptions(appId, headers);

    const targetUrl = `${publicBaseUrl}/store/webhook/zid/${encodeURIComponent(registration.storeId)}`;
    const failed: string[] = [];
    for (const event of ZID_WEBHOOK_EVENTS) {
      const res = await this.request(`${API_BASE_URL}/managers/webhooks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event,
          target_url: targetUrl,
          original_id: appId,
          username: ZID_WEBHOOK_USERNAME,
          password: registration.webhookSecret,
        }),
      });
      if (!res.ok) {
        const detail = zidErrorDetail(await jsonOrNull(res));
        failed.push(`${event} (${res.status}${detail ? `: ${detail}` : ''})`);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `Zid webhook subscription failed for ${failed.join(', ')}`,
      );
    }
  }

  /** `DELETE /managers/webhooks?original_id=<app id>`. Best-effort: a failure is logged, not thrown. */
  private async deleteSubscriptions(
    appId: string,
    headers: Headers,
  ): Promise<void> {
    const params = new URLSearchParams({ original_id: appId });
    const res = await this.request(
      `${API_BASE_URL}/managers/webhooks?${params.toString()}`,
      { method: 'DELETE', headers },
    );
    if (!res.ok && res.status !== 404) {
      this.logger.warn(
        `Zid webhook cleanup before subscribe failed: ${res.status}`,
        'ZidStoreProvider',
      );
    }
  }

  /** The per-connection secret we subscribed with is the Basic-auth password. */
  resolveWebhookSecret(connectionSecret: string | null): string | null {
    return connectionSecret && connectionSecret.length > 0
      ? connectionSecret
      : null;
  }

  /**
   * Constant-time comparison of the inbound `Authorization` header with the
   * one Zid was told to send. There is no body signature, so `rawBody` is
   * not part of the check.
   */
  verifyWebhookSignature(
    _rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): boolean {
    return safeSignatureEqual(
      signature.trim(),
      zidBasicAuthHeader(ZID_WEBHOOK_USERNAME, webhookSecret),
    );
  }

  /**
   * Zid documents no delivery id. `<event>:<resource id>:<updated_at>` keeps
   * successive status changes of one order distinct while a retry of the same
   * delivery collides. Without all three (envelope UNVERIFIED), null makes
   * the caller fall back to a hash of the raw body.
   */
  extractEventId(payload: unknown): string | null {
    const body = asWebhookPayload(payload);
    const event = eventNameOf(body);
    const resource = resourceOf(body);
    const id = scalarId(resource.id);
    const version = resource.updated_at ?? body.updated_at;
    return event && id && typeof version === 'string' && version.length > 0
      ? `${event}:${id}:${version}`
      : null;
  }

  /**
   * The event name is read from `event` or `event_name`, the resource from
   * `data` or the top level: the store-event envelope is not documented
   * (UNVERIFIED; capture a real delivery). No event name → null (ignored).
   */
  normalizeWebhookEvent(
    payload: unknown,
    storeId: string,
  ): StoreWebhookEvent | null {
    const body = asWebhookPayload(payload);
    const event = eventNameOf(body);
    if (!event) return null;
    const eventType = ZID_EVENT_TYPES[event] ?? 'unknown';
    const externalId =
      eventType === 'unknown' || eventType === 'app_uninstalled'
        ? ''
        : scalarId(resourceOf(body).id);
    return {
      eventType,
      externalId,
      storeId,
      payload: body as Record<string, unknown>,
    };
  }

  // ---- HTTP ----

  /** Headers for every non-product Merchant API call. */
  private managerHeaders(
    accessToken: string,
    context?: StoreOAuthCallbackContext,
  ): Headers {
    return {
      Authorization: `Bearer ${requireAuthorizationToken(context)}`,
      'X-Manager-Token': accessToken,
      Accept: 'application/json',
      'Accept-Language': 'en',
    };
  }

  /**
   * Product endpoints take the manager token as `Access-Token`, plus
   * `Store-Id` and `Role: Manager`. The docs say every call also needs
   * `Authorization`; sending it here too is UNVERIFIED but the safe reading.
   */
  private productHeaders(
    accessToken: string,
    context?: StoreOAuthCallbackContext,
  ): Headers {
    const storeId = context?.shop;
    if (!storeId) {
      throw new Error('Zid product call needs the store id');
    }
    return {
      Authorization: `Bearer ${requireAuthorizationToken(context)}`,
      'Access-Token': accessToken,
      'Store-Id': storeId,
      Role: 'Manager',
      Accept: 'application/json',
      'Accept-Language': 'en',
    };
  }

  /**
   * `fetch` that honours Zid's 60 requests/minute limit: a 429 waits and
   * retries, up to MAX_RATE_LIMIT_RETRIES times, then returns the 429 for the
   * caller to fail on.
   */
  private async request(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
      const delayMs = rateLimitDelayMs(res, attempt);
      this.logger.warn(
        `Zid rate limit hit (429); retrying in ${delayMs} ms (attempt ${attempt + 1} of ${MAX_RATE_LIMIT_RETRIES})`,
        'ZidStoreProvider',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function requireAuthorizationToken(
  context?: StoreOAuthCallbackContext,
): string {
  const token = context?.authorizationToken;
  if (!token) {
    // Connections made before migration 0066 never stored this token.
    throw new Error(
      'Zid connection has no partner authorization token; reconnect the store',
    );
  }
  return token;
}

/** `Retry-After` (seconds) when present, else 2s, 4s, 8s…; capped. */
export function rateLimitDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers?.get?.('retry-after'));
  const delay =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(delay, MAX_RATE_LIMIT_DELAY_MS);
}

function pageNumber(cursor: string | undefined): number {
  const page = Number(cursor);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

async function jsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function asWebhookPayload(payload: unknown): ZidWebhookPayload {
  return payload !== null && typeof payload === 'object' ? payload : {};
}

function eventNameOf(body: ZidWebhookPayload): string | undefined {
  const name = body.event ?? body.event_name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** A resource id as a string; '' for anything that is not a string or number. */
function scalarId(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function resourceOf(body: ZidWebhookPayload): {
  id?: unknown;
  updated_at?: unknown;
} {
  return body.data !== null && typeof body.data === 'object' ? body.data : body;
}
