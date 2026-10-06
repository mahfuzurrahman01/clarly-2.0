import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AUDIT_OUTCOMES } from '../persistence/drizzle/schema';

export const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorUserId: z
    .string()
    .describe('Supabase Auth user id of whoever performed the action.'),
  actorEmail: z
    .string()
    .nullable()
    .describe(
      'Resolved at read time from the team directory, never stored — so a renamed account never leaves a stale entry. Null when the actor is no longer on the team; their id still identifies them.',
    ),
  actorRole: z
    .string()
    .nullable()
    .describe(
      'The role the actor held WHEN they acted, not the role they hold now. A later role change must not rewrite history.',
    ),
  method: z.string(),
  route: z
    .string()
    .describe(
      'The route pattern, e.g. `/knowledge-base/documents/:id` — not the resolved path. Group by this; the specific id is `targetId`.',
    ),
  targetId: z
    .string()
    .nullable()
    .describe('The thing acted upon, when the route named one.'),
  statusCode: z.number().int(),
  outcome: z.enum(AUDIT_OUTCOMES),
  detail: z
    .string()
    .nullable()
    .describe(
      'What actually changed, in plain English, when the handler said. Null is normal and does not mean the entry is incomplete. The fallback when the console has no translation for `detailKey`.',
    ),
  detailKey: z
    .string()
    .nullable()
    .describe(
      'Stable key for the description (e.g. `order.approved`), for localising it. Null when the handler gave none, including every entry recorded before keys existed. Never renamed; see docs/HANDOFF.md for the list.',
    ),
  detailParams: z
    .record(z.union([z.string(), z.number()]))
    .nullable()
    .describe(
      'The values interpolated into `detail`, keyed per `detailKey`. Null exactly when `detailKey` is null.',
    ),
  createdAt: z.date(),
});

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export class AuditLogEntryDto extends createZodDto(auditLogEntrySchema) {}
export class AuditLogEntryListDto extends createZodDto(
  z.array(auditLogEntrySchema),
) {}

export const listAuditLogQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Page size, 1-200.'),
  before: z.coerce
    .date()
    .optional()
    .describe(
      'Keyset cursor: pass the `createdAt` of the last row you received to get the next page. Stable under concurrent writes, unlike an offset.',
    ),
});

export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;
export class ListAuditLogQueryDto extends createZodDto(
  listAuditLogQuerySchema,
) {}
