import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  MESSAGE_ROLES,
  TICKET_ESCALATION_REASONS,
  TICKET_STATUSES,
  type TicketEscalationReason,
} from '../persistence/drizzle/schema';

export const ticketRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  customerId: z.string().uuid(),
  conversationId: z
    .string()
    .uuid()
    .nullable()
    .describe('Null for tickets not raised by an agent run (T3).'),
  escalationReason: z.enum(TICKET_ESCALATION_REASONS),
  status: z.enum(TICKET_STATUSES),
  note: z.string().nullable(),
  assigneeId: z
    .string()
    .nullable()
    .describe("The claiming agent's user id. Null while status is OPEN."),
  confidence: z
    .number()
    .nullable()
    .describe(
      'Agent confidence at escalation time, 0-1. Null for non-agent tickets.',
    ),
  citedChunkIds: z.array(z.string()).nullable(),
  claimedAt: isoTimestamp().nullable(),
  resolvedAt: isoTimestamp().nullable(),
  createdAt: isoTimestamp(),
});

/** T8's batch-loaded shape — a ticket plus its customer and recent transcript, assembled in a bounded (not N+1) number of queries. */
export const ticketWithContextSchema = ticketRecordSchema.extend({
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  /**
   * Feature 18: the customer's intent label, joined in with the ticket rather
   * than fetched per card — the board shows the whole queue at once, so a
   * second round trip per ticket is exactly the N+1 T8 exists to prevent.
   * Null when this customer has never been labelled.
   */
  customerLabel: z
    .string()
    .nullable()
    .describe(
      "The customer's intent label in force (Feature 18). Null when never labelled. Correct it via `PUT /customers/{customerId}/label`.",
    ),
  /** Feature 18: whether the label in force is the agent\'s or a human override, so the board can mark corrected labels without a second call. */
  customerLabelSource: z.enum(['agent', 'human']).nullable(),
  /** Last 10 messages of the ticket's conversation, oldest-first — empty when conversationId is null (T3's non-agent-run tickets). */
  transcript: z
    .array(
      z.object({
        role: z.enum(MESSAGE_ROLES),
        content: z.string(),
      }),
    )
    .describe(
      'Last 10 messages of the ticket conversation, oldest-first. Empty when conversationId is null.',
    ),
});

export type TicketRecord = z.infer<typeof ticketRecordSchema>;
export type TicketWithContext = z.infer<typeof ticketWithContextSchema>;

export class TicketRecordDto extends createZodDto(ticketRecordSchema) {}
export class TicketWithContextDto extends createZodDto(
  ticketWithContextSchema,
) {}
export class TicketWithContextListDto extends createZodDto(
  z.array(ticketWithContextSchema),
) {}

/** Internal service input — never crosses the HTTP boundary, so no OpenAPI model. */
export interface CreateTicketInput {
  tenantId: string;
  customerId: string;
  escalationReason: TicketEscalationReason;
  conversationId?: string | null;
  note?: string;
  confidence?: number | null;
  citedChunkIds?: string[] | null;
}
