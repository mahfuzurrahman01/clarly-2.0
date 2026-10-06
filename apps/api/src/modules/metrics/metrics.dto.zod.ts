// Query-param validation for MetricsController — same ZodValidationPipe
// discipline as KanbanModule (Feature 5, Slice 3).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { KNOWLEDGE_GAP_REASONS } from './knowledge-gap.service';

/** What the pipe actually enforces. `z.coerce.date()` stays deliberately permissive — it accepts a date-only `2026-01-01` as readily as a full timestamp, and tightening that would reject callers that work today. */
export const dateRangeQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((range) => range.from <= range.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });

export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;

/**
 * The documented shape, kept separate from the validator above for two reasons:
 * a `.refine()`d schema is a `ZodEffects` with no introspectable object shape,
 * and `z.coerce.date()` converts to an empty OpenAPI schema. Both fields infer
 * to `Date`, matching what the pipe hands the handler.
 *
 * Divergence is intentional and one-directional: this advertises ISO 8601, the
 * validator accepts that plus looser forms. The `from <= to` rule is stated in
 * the operation description since OpenAPI cannot express it.
 */
export class DateRangeQueryDto extends createZodDto(
  z.object({
    from: isoTimestamp().describe(
      'Inclusive start of the reporting window (ISO 8601).',
    ),
    to: isoTimestamp().describe(
      'Inclusive end of the reporting window (ISO 8601). Must not be earlier than `from`.',
    ),
  }),
) {}

/** Built from the same fields rather than `dateRangeQuerySchema.extend()`: that schema is a `ZodEffects` (it carries the `from <= to` refinement), which has no `.extend()`. */
export const knowledgeGapQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((query) => query.from <= query.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });

export type KnowledgeGapQuery = z.infer<typeof knowledgeGapQuerySchema>;

/** Documented shape, separate from the validator for the same reasons as DateRangeQueryDto. */
export class KnowledgeGapQueryDto extends createZodDto(
  z.object({
    from: isoTimestamp().describe('Inclusive start of the window (ISO 8601).'),
    to: isoTimestamp().describe('Inclusive end of the window (ISO 8601).'),
    limit: z
      .number()
      .int()
      .describe('How many questions to return, newest first. 1-200.'),
  }),
) {}

export const knowledgeGapReportSchema = z.object({
  gaps: z.array(
    z.object({
      reason: z.enum(KNOWLEDGE_GAP_REASONS),
      question: z
        .string()
        .nullable()
        .describe(
          'What the customer asked. Null once the transcript has been purged (T16) — the escalation still counts, the wording is simply gone.',
        ),
      occurredAt: isoTimestamp(),
      conversationId: z.string().uuid().nullable(),
    }),
  ),
  totals: z.array(
    z.object({
      reason: z.enum(KNOWLEDGE_GAP_REASONS),
      count: z.number().int(),
    }),
  ),
});

export class KnowledgeGapReportDto extends createZodDto(
  knowledgeGapReportSchema,
) {}
