// F26 (Delivery Tracking): the console API's request/response shapes (D9).
//
// Zod-first like every other request shape in this app — F20 shipped bare TS
// interfaces on every write endpoint with no validation pipe anywhere, which
// the F26 review calls a P1 rather than a style note.
//
// Note what is NOT in any response type: `credentials`, and `webhookSecret`
// except from the one endpoint that mints it. A connection's credentials are
// write-only over HTTP.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  COURIER_NAMES,
  SHIPMENT_STATUSES,
} from '../persistence/drizzle/schema';
import { NOTIFIABLE_STATUSES } from './delivery-notification-settings.service';

/**
 * Credentials are a free-form string map because the shape is the COURIER's,
 * not ours: Aramex needs six fields, SMSA one. The single encrypted blob in
 * `courier_connections.credentials` is what makes that work without a column
 * per courier — and the adapter's `requireCredential()` is what rejects a
 * map that is missing what its courier needs, with an error naming the field.
 */
const credentialsSchema = z
  .record(z.string().min(1).max(512))
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one credential field is required.',
  })
  .refine((value) => Object.keys(value).length <= 20, {
    message: 'Too many credential fields.',
  });

export const upsertCourierConnectionSchema = z.object({
  courier: z.enum(COURIER_NAMES),
  accountRef: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe(
      "The merchant's account/shipper reference at the courier. Also the webhook routing key for J&T, which is why it is part of the connection's identity.",
    ),
  credentials: credentialsSchema.describe(
    'The courier-specific credential map. Encrypted at rest and never returned.',
  ),
});

export type UpsertCourierConnectionBody = z.infer<
  typeof upsertCourierConnectionSchema
>;
export class UpsertCourierConnectionBodyDto extends createZodDto(
  upsertCourierConnectionSchema,
) {}

export const courierConnectionSchema = z.object({
  id: z.string().uuid(),
  courier: z.enum(COURIER_NAMES),
  accountRef: z.string(),
  isActive: z.boolean(),
  /** True when this courier has a push surface we accept — i.e. a webhook secret is meaningful. */
  supportsWebhook: z.boolean(),
  hasWebhookSecret: z.boolean(),
  lastVerifiedAt: isoTimestamp().nullable(),
  lastPolledAt: isoTimestamp().nullable(),
  createdAt: isoTimestamp(),
  updatedAt: isoTimestamp(),
});

export type CourierConnectionDtoShape = z.infer<typeof courierConnectionSchema>;
export class CourierConnectionDto extends createZodDto(
  courierConnectionSchema,
) {}

/**
 * Manual shipment creation (D9 follow-up): the merchant console records a
 * tracking number the merchant already has from the courier — this endpoint
 * does not create a label at the courier, it only tells the platform a
 * shipment now exists for an order so `track_order` and the poll sweep have
 * something to read/refresh. `courierConnectionId` must be an ACTIVE
 * connection owned by this tenant, and `courier` must match that
 * connection's courier — the connection is the credential the poller uses,
 * so a mismatched pair would silently never poll.
 */
export const createShipmentSchema = z.object({
  courier: z.enum(COURIER_NAMES),
  courierConnectionId: z.string().uuid(),
  trackingNumber: z.string().trim().min(1).max(128),
});

export type CreateShipmentBody = z.infer<typeof createShipmentSchema>;
export class CreateShipmentBodyDto extends createZodDto(
  createShipmentSchema,
) {}

export const shipmentStatusEventSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  /** The courier's own code. Shown in the console for support; never in the tool payload the model sees (D4). */
  rawStatus: z.string(),
  location: z.string().nullable(),
  occurredAt: isoTimestamp(),
  source: z.enum(['poll', 'webhook', 'manual']),
});

export const shipmentSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  courier: z.enum(COURIER_NAMES),
  trackingNumber: z.string(),
  currentStatus: z.enum(SHIPMENT_STATUSES),
  currentStatusAt: isoTimestamp().nullable(),
  estimatedDeliveryAt: isoTimestamp().nullable(),
  deliveredAt: isoTimestamp().nullable(),
  lastNotifiedStatus: z.string().nullable(),
  lastNotifiedAt: isoTimestamp().nullable(),
  lastPolledAt: isoTimestamp().nullable(),
  pollFailureCount: z.number().int(),
  history: z.array(shipmentStatusEventSchema),
});

export type ShipmentDtoShape = z.infer<typeof shipmentSchema>;
export class ShipmentDto extends createZodDto(shipmentSchema) {}

export const deliveryNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  statusTemplates: z.record(z.string().uuid()),
  updatedAt: isoTimestamp().nullable(),
});

export class DeliveryNotificationSettingsDto extends createZodDto(
  deliveryNotificationSettingsSchema,
) {}

export const updateDeliveryNotificationSettingsSchema = z.object({
  enabled: z
    .boolean()
    .describe(
      'Opt-IN. While false, no proactive shipment message is ever sent, whatever is mapped below.',
    ),
  statusTemplates: z
    .record(z.enum(NOTIFIABLE_STATUSES), z.string().uuid())
    .describe(
      'Status -> approved utility template id. A status with no mapping is never notified. Only statuses worth a billed message are accepted.',
    ),
});

export type UpdateDeliveryNotificationSettingsBody = z.infer<
  typeof updateDeliveryNotificationSettingsSchema
>;
export class UpdateDeliveryNotificationSettingsBodyDto extends createZodDto(
  updateDeliveryNotificationSettingsSchema,
) {}
