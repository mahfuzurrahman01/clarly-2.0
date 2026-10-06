import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '../persistence/drizzle/schema';
import { isoTimestamp } from '../../common/iso-timestamp';

export const createWebhookBodySchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export type CreateWebhookBody = z.infer<typeof createWebhookBodySchema>;
export class CreateWebhookBodyDto extends createZodDto(
  createWebhookBodySchema,
) {}

const webhookRecordSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  enabled: z.boolean(),
  /** Delivery health, so a broken endpoint is visible on the tenant's own screen. */
  lastSuccessAt: isoTimestamp().nullable(),
  lastFailureAt: isoTimestamp().nullable(),
  lastFailureReason: z.string().nullable(),
});

export class WebhookListDto extends createZodDto(
  z.array(webhookRecordSchema),
) {}

export class WebhookCreatedDto extends createZodDto(
  webhookRecordSchema.extend({
    secret: z
      .string()
      .describe(
        'The signing secret, returned ONCE. Store it now — it is encrypted at rest and no read path will ever return it again.',
      ),
  }),
) {}
