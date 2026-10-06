// Feature 24 (Store Integrations): Salla store adapter.
// Implements the StoreProvider abstract class for the Salla e-commerce platform.
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
  type StoreConnectionTokens,
  type StoreTokens,
} from './store-provider.port';
import {
  expiryFrom,
  idOf,
  requireAccessToken,
  resolveNames,
  type OAuthTokenResponse,
  type RestWebhookPayload,
} from './store-api-types';
import {
  sallaErrorDetail,
  sallaImageUrl,
  sallaNextPage,
  sallaReceiverPhone,
  sallaStock,
  type SallaCreateOrderResponse,
  type SallaProductListResponse,
  type SallaUserInfoResponse,
} from './salla-api-types';
import {
  listRestOrdersByPhone,
  readRestOrder,
  type RestOrderReadOptions,
} from './rest-order-reader';
import { AppConfigService } from '../../core/config/app-config.service';

/** Products requested per page on catalogue sync. */
const PRODUCTS_PER_PAGE = 50;

/**
 * UNVERIFIED default: orders are created unpaid and settled on delivery. The
 * docs' example sends a single string (`"cod"`); this sends the array form.
 */
const ACCEPTED_PAYMENT_METHODS = ['cod'];

@Injectable()
export class SallaStoreProvider extends StoreProvider {
  readonly provider = 'salla' as const;

  /** Salla signs webhooks with HMAC-SHA256 (hex) over the raw body in this header. */
  readonly webhookSignatureHeader = 'x-salla-signature';

  constructor(private readonly config: AppConfigService) {
    super();
  }

  /** Merchant API root — `/admin/v2`, not `/v2` (docs/integrations/SALLA.md). */
  private get baseUrl(): string {
    return 'https://api.salla.dev/admin/v2';
  }

  private get tokenUrl(): string {
    return 'https://accounts.salla.sa/oauth2/token';
  }

  private get userInfoUrl(): string {
    return 'https://accounts.salla.sa/oauth2/user/info';
  }

  getOAuthAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.sallaClientId,
      redirect_uri: this.config.sallaRedirectUri,
      response_type: 'code',
      // Salla rejects any other scope (`invalid_scope`): permissions are the
      // App Scope set in the Partners portal; offline_access only asks for a
      // refresh token.
      scope: 'offline_access',
      state,
    });
    return `https://accounts.salla.sa/oauth2/auth?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<StoreConnectionTokens> {
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.sallaClientId,
        client_secret: this.config.sallaClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.config.sallaRedirectUri,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Salla token exchange failed: ${res.status}`);
    const data = (await res.json()) as OAuthTokenResponse;
    const accessToken = requireAccessToken('Salla', data);
    // Salla's token response carries no store identity; the merchant comes
    // from user info.
    const merchant = await this.fetchMerchant(accessToken);
    return {
      accessToken,
      refreshToken: data.refresh_token,
      expiresAt: expiryFrom(data),
      ...merchant,
    };
  }

  private async fetchMerchant(
    accessToken: string,
  ): Promise<{ storeId: string; storeName: string; storeUrl?: string }> {
    const res = await fetch(this.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Salla user info failed: ${res.status}`);
    const merchant = ((await res.json()) as SallaUserInfoResponse).data
      ?.merchant;
    const storeId = idOf(merchant?.id);
    // An empty storeId would collide every Salla connection on one key.
    if (storeId.length === 0) {
      throw new Error('Salla user info returned no merchant id');
    }
    return {
      storeId,
      storeName: merchant?.name ?? 'Salla Store',
      storeUrl: merchant?.domain,
    };
  }

  /** Salla's refresh grant — `grant_type=refresh_token`, NOT authorization_code. */
  async refreshAccessToken(refreshToken: string): Promise<StoreTokens> {
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.sallaClientId,
        client_secret: this.config.sallaClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) throw new Error(`Salla token refresh failed: ${res.status}`);
    const data = (await res.json()) as OAuthTokenResponse;
    return {
      accessToken: requireAccessToken('Salla', data),
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: expiryFrom(data),
    };
  }

  async listProducts(
    accessToken: string,
    after?: string,
  ): Promise<{
    products: StoreProduct[];
    hasNextPage: boolean;
    nextCursor?: string;
  }> {
    const page = after ? Number(after) : 1;
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(PRODUCTS_PER_PAGE),
    });
    const res = await fetch(`${this.baseUrl}/products?${query.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Salla products list failed: ${res.status}`);
    const data = (await res.json()) as SallaProductListResponse;
    const nextPage = sallaNextPage(data.pagination, page);
    return {
      products: (data.data ?? []).map((p) => {
        const { name, nameAr } = resolveNames({ name: p.name });
        return {
          externalId: idOf(p.id),
          name,
          nameAr,
          price: Number(p.price?.amount ?? 0) || 0,
          currency: p.price?.currency ?? 'SAR',
          ...sallaStock(p),
          imageUrl: sallaImageUrl(p.images),
          sku: p.sku,
          category: p.categories?.[0]?.name,
          metadata: {},
        };
      }),
      hasNextPage: nextPage !== undefined,
      nextCursor: nextPage === undefined ? undefined : String(nextPage),
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
  ): Promise<StoreOrderResult> {
    const res = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.orderBody(order)),
    });
    if (!res.ok) {
      const detail = sallaErrorDetail(await res.json().catch(() => null));
      throw new Error(
        `Salla order creation failed: ${res.status}${detail ? ` ${detail}` : ''}`,
      );
    }
    const data = ((await res.json()) as SallaCreateOrderResponse).data;
    if (!data?.id) {
      throw new Error('Salla order creation returned no order id');
    }
    return {
      orderId: idOf(data.id),
      paymentUrl: data.urls?.customer ?? '',
      total: Number(data.amounts?.total?.amount ?? 0) || 0,
      currency: data.amounts?.total?.currency ?? 'SAR',
    };
  }

  /**
   * `POST /orders` body per docs/integrations/SALLA.md. Salla needs a customer
   * by id, or name + mobile + email; we never hold an email, so without an id
   * the buyer goes in `receiver` (the docs' alternative). UNVERIFIED against a
   * live store: that `receiver` alone satisfies the customer requirement,
   * `ship_to` with only the free-text `address` (no `courier_id`, country or
   * city, which we do not collect), and that a product id `identifier` is
   * accepted for a variant (`variantId` is not sent). `notes` has no
   * documented field and is not sent.
   */
  private orderBody(order: {
    customerId?: string;
    customerPhone: string;
    customerName: string;
    shippingAddress: string;
    items: { productId: string; quantity: number }[];
  }): Record<string, unknown> {
    const buyer = order.customerId
      ? { customer: { id: order.customerId } }
      : {
          receiver: {
            name: order.customerName,
            ...sallaReceiverPhone(order.customerPhone),
          },
        };
    return {
      ...buyer,
      payment: {
        status: 'pending_payment',
        accepted_methods: ACCEPTED_PAYMENT_METHODS,
      },
      products: order.items.map((item) => ({
        identifier_type: 'id',
        identifier: item.productId,
        quantity: item.quantity,
      })),
      delivery_method: 'shipping',
      ship_to: { address: order.shippingAddress },
    };
  }

  private readOptions(accessToken: string): RestOrderReadOptions {
    return {
      provider: 'Salla',
      baseUrl: this.baseUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
      fallbackCurrency: 'SAR',
    };
  }

  getOrder(
    accessToken: string,
    externalOrderId: string,
  ): Promise<StoreOrderSummary | null> {
    return readRestOrder(this.readOptions(accessToken), externalOrderId);
  }

  listOrdersByCustomerPhone(
    accessToken: string,
    customerPhone: string,
  ): Promise<StoreOrderSummary[]> {
    // UNVERIFIED against a live Salla account: Salla's `GET /orders` documents
    // paging and status filters, but no phone filter this repo has been able
    // to confirm, so the generic `search` term is used to narrow the page.
    // That is a NARROWING convenience only — StoreOrderLookupService re-checks
    // every returned order against the asking customer's own phone before any
    // of it is returned, so an over-broad or ignored filter cannot leak
    // another customer's order.
    return listRestOrdersByPhone(
      this.readOptions(accessToken),
      'search',
      customerPhone,
    );
  }

  /** Per-connection secret (the merchant pastes it into Salla's webhook settings). */
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
      .digest('hex');
    return safeSignatureEqual(signature, expected);
  }

  extractEventId(
    payload: unknown,
    headers: StoreWebhookHeaders,
  ): string | null {
    const data = (payload ?? {}) as RestWebhookPayload;
    const fromPayload = data.event_id ?? data.id ?? data.data?.id;
    const id = idOf(fromPayload);
    if (id.length > 0) {
      // Salla reuses the resource id across event types, so the event name
      // is part of the key — a stock change and an order on the same id are
      // two distinct events, not a duplicate.
      return `${data.event ?? 'unknown'}:${id}`;
    }
    const headerId = headers['x-salla-event-id'];
    return headerId && headerId.length > 0 ? headerId : null;
  }

  normalizeWebhookEvent(
    payload: unknown,
    storeId: string,
  ): StoreWebhookEvent | null {
    const data = (payload ?? {}) as RestWebhookPayload;
    const event = data.event;
    if (!event) return null;
    const externalId = idOf(data.data?.id);
    const body = data as Record<string, unknown>;
    if (event === 'order.created') {
      return { eventType: 'order_created', externalId, storeId, payload: body };
    }
    if (event === 'product.updated') {
      return {
        eventType: 'product_updated',
        externalId,
        storeId,
        payload: body,
      };
    }
    if (event === 'stock.updated' || event === 'product.quantity.low') {
      return { eventType: 'stock_changed', externalId, storeId, payload: body };
    }
    return { eventType: 'unknown', externalId: '', storeId, payload: body };
  }
}
