// Feature 24 (Store Integrations): noop adapter for dev/test — bound when
// no store provider is configured (STORE_PROVIDER=none, the default).
// Follows the same "real no-op adapter, never a placeholder credential"
// pattern as NoopBillingProvider.
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppLoggerService } from '../../core';
import {
  StoreProvider,
  type StoreProduct,
  type StoreOrderResult,
  type StoreOrderSummary,
  type StoreWebhookEvent,
  type StoreConnectionTokens,
  type StoreTokens,
} from './store-provider.port';

@Injectable()
export class NoopStoreProvider extends StoreProvider {
  readonly provider = 'shopify' as const;

  /** Never used — verifyWebhookSignature() below always refuses. */
  readonly webhookSignatureHeader = 'x-noop-signature';

  constructor(private readonly logger: AppLoggerService) {
    super();
  }

  getOAuthAuthorizeUrl(state: string): string {
    this.logger.warn(
      `NoopStoreProvider: no store provider configured (STORE_PROVIDER=none) — would redirect to OAuth authorize. state=${state}`,
      'NoopStoreProvider',
    );
    return `https://noop.example.com/oauth/authorize?state=${state}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async exchangeCode(code: string): Promise<StoreConnectionTokens> {
    this.logger.warn(
      `NoopStoreProvider: no store provider configured (STORE_PROVIDER=none) — would exchange OAuth code ${code}. Returning fake credentials.`,
      'NoopStoreProvider',
    );
    return {
      accessToken: 'noop_tok_dev',
      storeId: 'noop_store_dev',
      storeName: 'Noop Store (dev)',
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async refreshAccessToken(): Promise<StoreTokens | null> {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listProducts(): Promise<{
    products: StoreProduct[];
    hasNextPage: boolean;
    nextCursor?: string;
  }> {
    this.logger.warn(
      'NoopStoreProvider: no store provider configured (STORE_PROVIDER=none) — returning empty product list.',
      'NoopStoreProvider',
    );
    return { products: [], hasNextPage: false };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createOrder(): Promise<StoreOrderResult> {
    this.logger.error(
      'NoopStoreProvider: refusing to create an order with no store provider configured (STORE_PROVIDER=none).',
      'NoopStoreProvider',
    );
    throw new ServiceUnavailableException(
      'Store integration is not configured on this deployment, so orders cannot be created here.',
    );
  }

  /**
   * Fail closed, read-shaped. An order lookup that THREW would surface a
   * store misconfiguration to a customer asking "where is my order" as an
   * error; answering "no order found" is both the honest result (there is no
   * store) and the shape F26 D4 mandates for a scoped lookup that cannot be
   * satisfied — never an unscoped or invented one.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getOrder(): Promise<StoreOrderSummary | null> {
    this.logger.warn(
      'NoopStoreProvider: order lookup with no store provider configured (STORE_PROVIDER=none) — reporting no order.',
      'NoopStoreProvider',
    );
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listOrdersByCustomerPhone(): Promise<StoreOrderSummary[]> {
    this.logger.warn(
      'NoopStoreProvider: order history requested with no store provider configured (STORE_PROVIDER=none) — returning none.',
      'NoopStoreProvider',
    );
    return [];
  }

  /** No secret, ever — the webhook path treats null as "reject". */
  resolveWebhookSecret(): string | null {
    return null;
  }

  verifyWebhookSignature(): boolean {
    this.logger.warn(
      'NoopStoreProvider: received a webhook request with no store provider configured (STORE_PROVIDER=none) — ignoring.',
      'NoopStoreProvider',
    );
    return false;
  }

  extractEventId(): string | null {
    return null;
  }

  normalizeWebhookEvent(): StoreWebhookEvent | null {
    return null;
  }
}
