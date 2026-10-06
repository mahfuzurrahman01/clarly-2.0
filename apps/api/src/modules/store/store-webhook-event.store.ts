// Feature 24 (Store Integrations): the idempotency log for store webhooks.
//
// `store_webhook_events` existed from day one and nothing wrote to it — every
// provider retry (Salla/Zid/Shopify all retry on non-2xx, and Shopify retries
// on timeout even after a 200 that was slow) re-applied the same stock/order
// event. Claim-before-process, keyed on the table's own
// (provider, store_id, event_id) unique constraint: the INSERT is the lock,
// so two concurrent deliveries of the same event cannot both win.
//
// No RLS on this table (it is read/written before a tenant is known, same as
// social_channels) — hence runAdminQuery, and hence the routing key is always
// provider + store_id, never anything the caller asserts about a tenant.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { storeWebhookEvents } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import type { StoreProviderName } from './store-provider-name';

export interface WebhookEventClaim {
  provider: StoreProviderName;
  storeId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class StoreWebhookEventStore {
  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Attempts to claim an event for processing.
   * @returns the new row id, or null when this (provider, store, event) was already seen.
   */
  async claim(event: WebhookEventClaim): Promise<string | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .insert(storeWebhookEvents)
        .values({
          provider: event.provider,
          storeId: event.storeId,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: event.payload,
          status: 'received',
        })
        .onConflictDoNothing({
          target: [
            storeWebhookEvents.provider,
            storeWebhookEvents.storeId,
            storeWebhookEvents.eventId,
          ],
        })
        .returning({ id: storeWebhookEvents.id }),
    );
    return rows[0]?.id ?? null;
  }

  async markStatus(
    id: string,
    status: 'processed' | 'failed' | 'ignored',
  ): Promise<void> {
    await this.persistence.runAdminQuery((db) =>
      db
        .update(storeWebhookEvents)
        .set({ status, processedAt: new Date() })
        .where(eq(storeWebhookEvents.id, id)),
    );
  }

  /** Test/ops helper — the processing status of a specific delivered event. */
  async findStatus(
    provider: StoreProviderName,
    storeId: string,
    eventId: string,
  ): Promise<string | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ status: storeWebhookEvents.status })
        .from(storeWebhookEvents)
        .where(
          and(
            eq(storeWebhookEvents.provider, provider),
            eq(storeWebhookEvents.storeId, storeId),
            eq(storeWebhookEvents.eventId, eventId),
          ),
        )
        .limit(1),
    );
    return rows[0]?.status ?? null;
  }
}
