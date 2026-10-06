// F19 (D8): segments' request/response contracts. Every write body is a Zod
// schema + `createZodDto`, applied with `ZodValidationPipe` — no bare TS
// interfaces (the direct F20 lesson).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { nodeSchema } from './segment-definition.schema';

export const MAX_SEGMENT_NAME_LENGTH = 100;
export const MAX_SEGMENT_DESCRIPTION_LENGTH = 500;

export const createSegmentBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_SEGMENT_NAME_LENGTH),
  description: z
    .string()
    .trim()
    .max(MAX_SEGMENT_DESCRIPTION_LENGTH)
    .nullable()
    .optional(),
  definition: nodeSchema,
});
export type CreateSegmentBody = z.infer<typeof createSegmentBodySchema>;
export class CreateSegmentBodyDto extends createZodDto(
  createSegmentBodySchema,
) {}

export const updateSegmentBodySchema = createSegmentBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateSegmentBody = z.infer<typeof updateSegmentBodySchema>;
export class UpdateSegmentBodyDto extends createZodDto(
  updateSegmentBodySchema,
) {}

export const segmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  definition: nodeSchema,
  lastResolvedCount: z.number().int().nullable(),
  lastResolvedAt: isoTimestamp().nullable(),
  createdAt: isoTimestamp(),
  updatedAt: isoTimestamp(),
});
export type SegmentResponse = z.infer<typeof segmentSchema>;
export class SegmentDto extends createZodDto(segmentSchema) {}

export const segmentPreviewResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  resolvedAt: isoTimestamp(),
});
export type SegmentPreviewResponse = z.infer<
  typeof segmentPreviewResponseSchema
>;
export class SegmentPreviewDto extends createZodDto(
  segmentPreviewResponseSchema,
) {}
