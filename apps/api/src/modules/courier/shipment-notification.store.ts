// F26 (Delivery Tracking): the "already told them" claim log (D5 gate 6).
//
// The INSERT is the lock. `claim()` inserts (shipment_id, status) with
// `onConflictDoNothing`; no row back means somebody else already claimed that
// transition, so the caller stops without sending. That is the same
// claim-before-act pattern as `StoreWebhookEventStore.claim()`, and it is
// what makes a duplicate billed template impossible rather than unlikely when
// a poll and a webhook observe the same transition at the same instant.
//
// A claim is taken BEFORE the gates that record a skip too, so "we decided
// not to message about this transition" is also remembered — otherwise every
// sweep would re-evaluate the same skipped transition and re-notify the
// merchant about the same missing template.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { shipmentNotifications } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { ShipmentNotificationOutcome } from '../persistence/drizzle/schema';
import type { ShipmentStatus } from './ports/courier-connector.port';

export interface ShipmentNotificationRecord {
  id: string;
  shipmentId: string;
  status: string;
  outcome: ShipmentNotificationOutcome;
  templateId: string | null;
  messageId: string | null;
  detail: string | null;
  createdAt: Date;
}

@Injectable()
export class ShipmentNotificationStore {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * @returns the new claim row's id, or null when this (shipment, status) was
   * already claimed by someone else. Null means STOP — never "try anyway".
   */
  async claim(
    tenantId: string,
    shipmentId: string,
    status: ShipmentStatus,
  ): Promise<string | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(shipmentNotifications)
          .values({ tenantId, shipmentId, status, outcome: 'claimed' })
          .onConflictDoNothing({
            target: [
              shipmentNotifications.shipmentId,
              shipmentNotifications.status,
            ],
          })
          .returning({ id: shipmentNotifications.id }),
      tenantId,
    );
    return rows[0]?.id ?? null;
  }

  async settle(
    tenantId: string,
    claimId: string,
    outcome: ShipmentNotificationOutcome,
    detail?: {
      templateId?: string | null;
      messageId?: string | null;
      detail?: string | null;
    },
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(shipmentNotifications)
          .set({
            outcome,
            templateId: detail?.templateId ?? null,
            messageId: detail?.messageId ?? null,
            // Truncated: this is courier/BSP failure text and it is shown in
            // the console, so it must not be able to grow without bound.
            detail: detail?.detail ? detail.detail.slice(0, 500) : null,
          })
          .where(
            and(
              eq(shipmentNotifications.id, claimId),
              eq(shipmentNotifications.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }

  async listForShipment(
    tenantId: string,
    shipmentId: string,
  ): Promise<ShipmentNotificationRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(shipmentNotifications)
          .where(
            and(
              eq(shipmentNotifications.tenantId, tenantId),
              eq(shipmentNotifications.shipmentId, shipmentId),
            ),
          ),
      tenantId,
    );
    return rows.map((row) => ({
      id: row.id,
      shipmentId: row.shipmentId,
      status: row.status,
      outcome: row.outcome as ShipmentNotificationOutcome,
      templateId: row.templateId,
      messageId: row.messageId,
      detail: row.detail,
      createdAt: row.createdAt,
    }));
  }
}
