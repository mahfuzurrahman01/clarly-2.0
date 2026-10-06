// Feature 24 (Store Integrations): store webhook processing.
//
// Order of operations is the security contract here, and all three steps were
// broken or absent in the first cut:
//   1. Resolve the connection from (provider, store_id) — the routing key.
//   2. VERIFY the signature against a real secret, in the provider's real
//      header. No secret or no signature ⇒ 401, never "process unverified".
//      (Before: `webhookSecret` was never populated and the header read was an
//      invented `x-webhook-signature`, so verification never ran at all.)
//   3. Claim the event in `store_webhook_events` before doing any work, so a
//      provider retry is a no-op instead of a second stock mutation.
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CatalogService } from '../catalog/catalog.service';
import { AppLoggerService } from '../core';
import {
  StoreConnectionService,
  type StoreConnection,
} from './store-connection.service';
import { StoreProviderRegistry } from './store-provider.registry';
import { StoreSyncService } from './store-sync.service';
import { StoreWebhookEventStore } from './store-webhook-event.store';
import type { StoreProviderName } from './store-provider-name';
import type {
  StoreProvider,
  StoreWebhookEvent,
  StoreWebhookHeaders,
} from './ports/store-provider.port';

export interface WebhookOutcome {
  processed: boolean;
  duplicate?: boolean;
  event?: string;
}

@Injectable()
export class StoreWebhookService {
  /** Connections with a webhook-triggered re-sync running in this process; a burst of stock events re-syncs once. */
  private readonly resyncsInFlight = new Set<string>();

  constructor(
    private readonly connectionService: StoreConnectionService,
    private readonly registry: StoreProviderRegistry,
    private readonly eventStore: StoreWebhookEventStore,
    private readonly catalogService: CatalogService,
    private readonly syncService: StoreSyncService,
    private readonly logger: AppLoggerService,
  ) {}

  async handleWebhook(
    provider: StoreProviderName,
    storeId: string,
    rawBody: Buffer | undefined,
    headers: StoreWebhookHeaders,
  ): Promise<WebhookOutcome> {
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException('Missing webhook body');
    }

    const connection = await this.connectionService.findByProviderAndStoreId(
      provider,
      storeId,
    );
    if (!connection) {
      // Not 404 with detail: an unknown (provider, store) must not be
      // distinguishable from a known one with a bad signature.
      this.logger.warn(
        `Store webhook for unknown connection provider=${provider} store=${storeId}`,
        'StoreWebhookService',
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const adapter = this.registry.forProvider(provider);
    this.assertSignature(
      adapter,
      connection,
      rawBody,
      headers,
      provider,
      storeId,
    );

    const payload = this.parseBody(rawBody);
    if (payload === null) {
      throw new UnauthorizedException('Malformed webhook payload');
    }

    const event = adapter.normalizeWebhookEvent(payload, storeId, headers);
    if (!event) {
      return { processed: false };
    }

    const eventId =
      adapter.extractEventId(payload, headers) ??
      // No provider-native id: the body hash is a stable-enough key to stop a
      // literal retry of the same delivery, and is documented as such.
      createHash('sha256').update(rawBody).digest('hex');

    const claimId = await this.eventStore.claim({
      provider,
      storeId,
      eventId,
      eventType: event.eventType,
      payload,
    });
    if (!claimId) {
      this.logger.debug(
        `Duplicate store webhook ignored: provider=${provider} store=${storeId} event=${eventId}`,
        'StoreWebhookService',
      );
      return { processed: false, duplicate: true, event: event.eventType };
    }

    try {
      const handled = await this.processEvent(event, connection);
      await this.eventStore.markStatus(
        claimId,
        handled ? 'processed' : 'ignored',
      );
      return { processed: handled, event: event.eventType };
    } catch (err) {
      await this.eventStore.markStatus(claimId, 'failed');
      throw err;
    }
  }

  private assertSignature(
    adapter: StoreProvider,
    connection: StoreConnection,
    rawBody: Buffer,
    headers: StoreWebhookHeaders,
    provider: StoreProviderName,
    storeId: string,
  ): void {
    const secret = adapter.resolveWebhookSecret(connection.webhookSecret);
    const signature = headers[adapter.webhookSignatureHeader];
    if (!secret || !signature) {
      this.logger.error(
        `Store webhook rejected (no ${!secret ? 'secret configured' : 'signature header'}): provider=${provider} store=${storeId}`,
        'StoreWebhookService',
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!adapter.verifyWebhookSignature(rawBody, signature, secret)) {
      this.logger.error(
        `Store webhook signature mismatch: provider=${provider} store=${storeId}`,
        'StoreWebhookService',
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }

  private parseBody(rawBody: Buffer): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** @returns true when the event actually changed something; false = recorded but ignored. */
  private async processEvent(
    event: StoreWebhookEvent,
    connection: StoreConnection,
  ): Promise<boolean> {
    switch (event.eventType) {
      case 'stock_changed': {
        const externalId = event.externalId;
        const data = (event.payload?.data ?? event.payload) as Record<
          string,
          unknown
        >;
        const stock = webhookStock(data);
        if (!externalId || stock === undefined) {
          return false;
        }
        const updated = await this.catalogService.updateStock(
          connection.tenantId,
          externalId,
          stock,
        );
        this.logger.log(
          `Stock webhook applied=${updated}: product ${externalId}, stock ${stock}, tenant ${connection.tenantId}`,
          'StoreWebhookService',
        );
        return updated;
      }
      case 'inventory_changed':
        // Shopify's `inventory_levels/update` names an inventory item and one
        // location's count, neither of which the catalogue can apply (it is
        // keyed on the product id and holds the variant total). Re-syncing
        // the connection reads the real total through the normal sync path,
        // which also records a `store_sync_jobs` row. Not awaited: Shopify
        // wants a 2xx within 5 s, and a full sync can take longer.
        return this.resyncInBackground(connection);
      case 'app_uninstalled': {
        // After an uninstall every token returns 401: stop syncing and
        // pushing to this store, the same as a console disconnect.
        const disconnected = await this.connectionService.markDisconnected(
          connection.tenantId,
          connection.id,
        );
        this.logger.log(
          `Store app uninstalled: connection ${connection.id} disconnected=${disconnected}, tenant ${connection.tenantId}`,
          'StoreWebhookService',
        );
        return disconnected;
      }
      case 'product_updated':
        this.logger.log(
          `Product update webhook recorded: ${event.externalId} (re-sync happens on the next sync sweep)`,
          'StoreWebhookService',
        );
        return false;
      case 'order_created':
        this.logger.log(
          `Order created webhook recorded: ${event.externalId}`,
          'StoreWebhookService',
        );
        return false;
      case 'order_updated':
        // Order read-back is live (StoreOrderLookupService), so a status
        // change needs no local write; recorded for idempotency and audit.
        this.logger.log(
          `Order updated webhook recorded: ${event.externalId}`,
          'StoreWebhookService',
        );
        return false;
      default:
        this.logger.warn(
          `Unknown store webhook event type: ${event.eventType}`,
          'StoreWebhookService',
        );
        return false;
    }
  }

  /** @returns true when a re-sync was started; false when one is already running for this connection. */
  private resyncInBackground(connection: StoreConnection): boolean {
    if (this.resyncsInFlight.has(connection.id)) return false;
    this.resyncsInFlight.add(connection.id);
    void this.syncService
      .syncConnection(connection)
      .catch((err: unknown) => {
        this.logger.error(
          `Webhook-triggered re-sync failed for connection ${connection.id}: ${err instanceof Error ? err.message : String(err)}`,
          'StoreWebhookService',
        );
      })
      .finally(() => this.resyncsInFlight.delete(connection.id));
    return true;
  }
}

const WEBHOOK_STOCK_FIELDS = ['stock', 'quantity', 'available'] as const;

/**
 * The stock a webhook reports: a count, `null` when the field is present but
 * null (the store does not track it — `Number(null)` would read as 0, sold
 * out), or `undefined` when there is no usable stock field.
 */
function webhookStock(
  data: Record<string, unknown> | undefined,
): number | null | undefined {
  const field = WEBHOOK_STOCK_FIELDS.find((key) => data?.[key] !== undefined);
  if (!field) return undefined;
  const raw = data?.[field];
  if (raw === null) return null;
  const stock = Number(raw);
  return Number.isFinite(stock) ? stock : undefined;
}
