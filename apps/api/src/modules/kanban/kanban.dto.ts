// Product shell (KanbanModule, T7/T8): the console API's request/response
// contract. Query params are untrusted external input (CLAUDE.md's "never
// trust external data") — validated with the same Zod discipline used
// everywhere else in this app (env.schema.ts, jwt-claims.ts), not
// class-validator decorators, to keep one validation library across the
// codebase.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  TICKET_ESCALATION_REASONS,
  TICKET_STATUSES,
} from '../persistence/drizzle/schema';

export const listTicketsQuerySchema = z.object({
  status: z
    .enum(TICKET_STATUSES)
    .optional()
    .describe('Filter to one status. Omit to return every ticket.'),
  assignee: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Whose tickets: a user id, the literal `me` for the caller's own, or `unassigned` for the queue nobody owns. Omit for all of them.",
    ),
  // F25/D5.1 item 4. The console's Complaints lane is this filter
  // (`?escalationReason=CUSTOMER_COMPLAINT`), not a new column, a new board or
  // a new table — the complaint signal rides the escalation-reason mechanism
  // that CUSTOMER_DISTRESS already uses.
  escalationReason: z
    .enum(TICKET_ESCALATION_REASONS)
    .optional()
    .describe(
      'Filter to one escalation reason. Omit for every reason. `CUSTOMER_COMPLAINT` is the Complaints lane.',
    ),
});

export const assignTicketBodySchema = z.object({
  /** Null hands it back to the queue. */
  assigneeId: z.string().uuid().nullable(),
});

export type AssignTicketBody = z.infer<typeof assignTicketBodySchema>;
export class AssignTicketBodyDto extends createZodDto(assignTicketBodySchema) {}

export const teamMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  appRole: z.string(),
});

export class TeamMemberListDto extends createZodDto(
  z.array(teamMemberSchema),
) {}

export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export class ListTicketsQueryDto extends createZodDto(listTicketsQuerySchema) {}

/**
 * The slice of tenant policy the board itself needs. The full policy is
 * admin-only (`GET /onboarding/tenant-policy`), but the stuck-ticket threshold
 * is operational data every agent needs to render the board correctly — so it
 * is exposed here, on the ungated kanban surface, instead of widening the
 * admin config endpoint.
 */
export const boardConfigSchema = z.object({
  stuckTicketThresholdMinutes: z
    .number()
    .int()
    .describe(
      'Minutes an unclaimed ticket may sit before the console flags it stuck. Falls back to the platform default when the tenant has no policy row.',
    ),
});

export type BoardConfig = z.infer<typeof boardConfigSchema>;

export class BoardConfigDto extends createZodDto(boardConfigSchema) {}
