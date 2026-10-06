// F19 (D8): campaigns' request/response contracts.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  CAMPAIGN_RECIPIENT_STATUSES,
  CAMPAIGN_STATUSES,
} from '../persistence/drizzle/schema';

export const MAX_CAMPAIGN_NAME_LENGTH = 100;

/** Closed whitelist (D2) — no expressions, no arbitrary column access. */
export const campaignTemplateValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('literal'), value: z.string().max(1000) }),
  z.object({
    type: z.literal('customer_field'),
    field: z.enum(['name', 'phone']),
    fallback: z.string().max(200),
  }),
]);

export const createCampaignBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_CAMPAIGN_NAME_LENGTH),
  segmentId: z.string().uuid(),
  templateId: z.string().uuid(),
  templateValues: z.array(campaignTemplateValueSchema).max(20).default([]),
  phoneNumberId: z.string().trim().min(1),
  spendCapUsd: z.number().positive().optional(),
});
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;
export class CreateCampaignBodyDto extends createZodDto(
  createCampaignBodySchema,
) {}

/** `PUT /campaigns/:id` — draft only (409 otherwise). Every field optional; an empty body is a no-op, not an error. */
export const updateCampaignBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CAMPAIGN_NAME_LENGTH),
    segmentId: z.string().uuid(),
    templateId: z.string().uuid(),
    templateValues: z.array(campaignTemplateValueSchema).max(20),
    phoneNumberId: z.string().trim().min(1),
    spendCapUsd: z.number().positive(),
  })
  .partial();
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;
export class UpdateCampaignBodyDto extends createZodDto(
  updateCampaignBodySchema,
) {}

/**
 * `POST /campaigns/:id/schedule`. `sendAt` absent — or in the past — means
 * "send now": pressing Send and scheduling for a time that has arrived are
 * the same operation and are deliberately not two endpoints.
 */
export const scheduleCampaignBodySchema = z.object({
  sendAt: z.coerce.date().nullable().optional(),
});
export type ScheduleCampaignBody = z.infer<typeof scheduleCampaignBodySchema>;
export class ScheduleCampaignBodyDto extends createZodDto(
  scheduleCampaignBodySchema,
) {}

export const listCampaignRecipientsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: z.enum(CAMPAIGN_RECIPIENT_STATUSES).optional(),
});
export type ListCampaignRecipientsQuery = z.infer<
  typeof listCampaignRecipientsQuerySchema
>;
export class ListCampaignRecipientsQueryDto extends createZodDto(
  listCampaignRecipientsQuerySchema,
) {}

export const listCampaignsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
export class ListCampaignsQueryDto extends createZodDto(
  listCampaignsQuerySchema,
) {}

export const campaignSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  segmentId: z.string().uuid(),
  templateId: z.string().uuid(),
  templateValues: z.array(campaignTemplateValueSchema),
  phoneNumberId: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  scheduledAt: isoTimestamp().nullable(),
  startedAt: isoTimestamp().nullable(),
  completedAt: isoTimestamp().nullable(),
  recipientCount: z.number().int(),
  estimatedCostUsd: z.number(),
  spendCapUsd: z.number(),
  spentUsd: z.number(),
  pauseReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: isoTimestamp(),
  updatedAt: isoTimestamp(),
});
export type CampaignResponse = z.infer<typeof campaignSchema>;
export class CampaignDto extends createZodDto(campaignSchema) {}
