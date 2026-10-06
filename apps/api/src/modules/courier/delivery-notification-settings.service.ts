// F26 (Delivery Tracking): the per-tenant opt-in for proactive shipment
// updates (D5 gate 2 and gate 3).
//
// `enabled` is an opt-IN with a false default, because every message this
// feature sends is a billed, business-initiated WhatsApp template. A tenant
// who has never opened this screen must never send one, and "we turned it on
// for you" is not a recoverable mistake — Meta has already charged them and
// their customer has already been messaged.
//
// `statusTemplates` decides the notifiable set: a status with no mapping is
// never notified, so the tenant chooses which transitions are worth a message
// rather than the platform hard-coding five of them.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { deliveryNotificationSettings } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { ShipmentStatus } from './ports/courier-connector.port';

/** The statuses D5 says are worth a proactive message. A tenant maps the subset they want. */
export const NOTIFIABLE_STATUSES = [
  'picked_up',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'returned',
] as const satisfies readonly ShipmentStatus[];

export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

export interface DeliveryNotificationSettings {
  tenantId: string;
  enabled: boolean;
  /** `{ "<ShipmentStatus>": "<message_templates.id>" }`. */
  statusTemplates: Record<string, string>;
  updatedAt: Date | null;
}

export interface UpdateDeliveryNotificationSettingsInput {
  enabled: boolean;
  statusTemplates: Record<string, string>;
}

@Injectable()
export class DeliveryNotificationSettingsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * A tenant with no row is not an error — it is a tenant who has not opted
   * in, which is the default state and the one that must never send. The
   * absent row is answered with the disabled defaults rather than a null the
   * caller has to remember to treat as "off".
   */
  async get(tenantId: string): Promise<DeliveryNotificationSettings> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(deliveryNotificationSettings)
          .where(eq(deliveryNotificationSettings.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    const row = rows[0];
    return {
      tenantId,
      enabled: row?.enabled ?? false,
      statusTemplates: row?.statusTemplates ?? {},
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async upsert(
    tenantId: string,
    input: UpdateDeliveryNotificationSettingsInput,
  ): Promise<DeliveryNotificationSettings> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(deliveryNotificationSettings)
          .values({
            tenantId,
            enabled: input.enabled,
            statusTemplates: input.statusTemplates,
          })
          .onConflictDoUpdate({
            target: deliveryNotificationSettings.tenantId,
            set: {
              enabled: input.enabled,
              statusTemplates: input.statusTemplates,
              updatedAt: new Date(),
            },
          })
          .returning(),
      tenantId,
    );
    return {
      tenantId,
      enabled: row.enabled,
      statusTemplates: row.statusTemplates,
      updatedAt: row.updatedAt,
    };
  }
}
