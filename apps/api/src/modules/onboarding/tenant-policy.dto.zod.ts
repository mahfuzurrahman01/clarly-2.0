// Request-body validation for TenantPolicyController — same
// ZodValidationPipe discipline as KanbanModule/MetricsModule.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const upsertTenantPolicyBodySchema = z.object({
  confidenceThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Below this agent confidence, a run escalates to a human ticket.',
    ),
  forbiddenTopics: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Topics the agent must refuse and escalate instead of answering.',
    ),
  tonePersonaOverride: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Replaces the default persona in the system prompt. Null clears it.',
    ),
  rerankEnabled: z
    .boolean()
    .optional()
    .describe('Enables the retrieval rerank pass for this tenant.'),
  stuckTicketThresholdMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Minutes a ticket may sit unclaimed before it is flagged stuck.'),
});

export type UpsertTenantPolicyBody = z.infer<
  typeof upsertTenantPolicyBodySchema
>;

/** Every field optional — this is a PATCH, so omitted fields keep their current value rather than resetting. */
export class UpsertTenantPolicyBodyDto extends createZodDto(
  upsertTenantPolicyBodySchema,
) {}
