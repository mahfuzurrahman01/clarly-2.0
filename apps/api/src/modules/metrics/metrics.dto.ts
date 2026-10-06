import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { TICKET_ESCALATION_REASONS } from '../persistence/drizzle/schema';

export interface DateRange {
  from: Date;
  to: Date;
}

export const resolutionRateResultSchema = z.object({
  from: isoTimestamp(),
  to: isoTimestamp(),
  totalConversations: z.number().int(),
  resolvedConversations: z.number().int(),
  resolutionRate: z
    .number()
    .describe(
      'resolvedConversations / totalConversations, or 0 when there were none — never NaN.',
    ),
});

export type ResolutionRateResult = z.infer<typeof resolutionRateResultSchema>;

export const escalationBreakdownSchema = z
  .record(z.enum(TICKET_ESCALATION_REASONS), z.number().int())
  .describe(
    'Ticket count per escalation reason. Reasons with no tickets in the window are omitted.',
  );

/** `Partial<>` rather than the raw inference: a window with no tickets of a given reason omits that key entirely, and Zod v3's `z.record` types every enum key as required. */
export type EscalationBreakdown = Partial<
  z.infer<typeof escalationBreakdownSchema>
>;

export const firstResponseTimeResultSchema = z.object({
  from: isoTimestamp(),
  to: isoTimestamp(),
  /** Conversations in the window that have a measured first response — the denominator behind the median, so a tenant can see whether it rests on 4 conversations or 4,000. */
  measuredConversations: z.number().int(),
  medianMs: z
    .number()
    .int()
    .nullable()
    .describe(
      "Median milliseconds from the customer's first message to the first reply. Null when no conversation in the window was ever replied to — distinct from 0, which would claim an instant answer.",
    ),
  p90Ms: z
    .number()
    .int()
    .nullable()
    .describe('The slow tail beside the median, same null semantics.'),
});

export type FirstResponseTimeResult = z.infer<
  typeof firstResponseTimeResultSchema
>;

export class FirstResponseTimeResultDto extends createZodDto(
  firstResponseTimeResultSchema,
) {}
export class ResolutionRateResultDto extends createZodDto(
  resolutionRateResultSchema,
) {}
export class EscalationBreakdownDto extends createZodDto(
  escalationBreakdownSchema,
) {}
