// F26 (Delivery Tracking): the idempotency claim log for courier push
// callbacks (D6 step 4).
//
// No RLS on `courier_webhook_events`, deliberately: the row is claimed BEFORE
// the tenant is known, from the (courier, account_ref) routing key alone —
// the same documented pre-tenant carve-out as `store_webhook_events`. Hence
// `runAdminQuery`, and hence the routing key is always the URL's own
// parameters, never anything the body asserts about a tenant.
//
// The INSERT is the claim. J&T retries aggressively, so a replayed body must
// be a no-op — not a second status application, and certainly not a second
// billed template.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { courierWebhookEvents } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import type { CourierWebhookEventStatus } from '../persistence/drizzle/schema';

export interface CourierWebhookEventClaim {
  courier: string;
  accountRef: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class CourierWebhookEventStore {
  constructor(private readonly persistence: PersistenceService) {}

  /** @returns the new row id, or null when this (courier, account, event) was already seen. */
  async claim(event: CourierWebhookEventClaim): Promise<string | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .insert(courierWebhookEvents)
        .values({
          courier: event.courier,
          accountRef: event.accountRef,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: event.payload,
          status: 'received',
        })
        .onConflictDoNothing({
          target: [
            courierWebhookEvents.courier,
            courierWebhookEvents.accountRef,
            courierWebhookEvents.eventId,
          ],
        })
        .returning({ id: courierWebhookEvents.id }),
    );
    return rows[0]?.id ?? null;
  }

  async markStatus(
    id: string,
    status: Exclude<CourierWebhookEventStatus, 'received'>,
  ): Promise<void> {
    await this.persistence.runAdminQuery((db) =>
      db
        .update(courierWebhookEvents)
        .set({ status, processedAt: new Date() })
        .where(eq(courierWebhookEvents.id, id)),
    );
  }

  /** Test/ops helper — what happened to a specific delivered event. */
  async findStatus(
    courier: string,
    accountRef: string,
    eventId: string,
  ): Promise<string | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ status: courierWebhookEvents.status })
        .from(courierWebhookEvents)
        .where(
          and(
            eq(courierWebhookEvents.courier, courier),
            eq(courierWebhookEvents.accountRef, accountRef),
            eq(courierWebhookEvents.eventId, eventId),
          ),
        )
        .limit(1),
    );
    return rows[0]?.status ?? null;
  }
}
