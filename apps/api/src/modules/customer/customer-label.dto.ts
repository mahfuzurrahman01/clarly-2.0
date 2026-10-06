// Feature 18: the label read/override contract. Zod-first like every other
// request/response shape in this app (kanban.dto.ts, customer-consent.dto.ts).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { AGENT_CUSTOMER_LABELS } from '../persistence/drizzle/schema';

/** Long enough for a tenant-defined taxonomy, short enough that the column is not a free-text dumping ground. */
export const MAX_CUSTOMER_LABEL_LENGTH = 40;

export const customerLabelSchema = z.object({
  customerId: z.string().uuid(),
  label: z
    .string()
    .describe(
      'The label in force right now. One of `hot`/`warm`/`cold` when agent-derived; any tenant-defined value when a human set it.',
    ),
  source: z
    .enum(['agent', 'human'])
    .describe(
      'Who the label in force came from. Derived from `overriddenAt`, never stored separately — two columns that can disagree is a bug waiting to happen.',
    ),
  overriddenAt: isoTimestamp()
    .nullable()
    .describe(
      'When a human last overrode this label. While non-null, agent turns do not change `label` (override-wins precedence).',
    ),
  overriddenBy: z
    .string()
    .uuid()
    .nullable()
    .describe('The user id that overrode it. Null when never overridden.'),
  agentLabel: z
    .enum(AGENT_CUSTOMER_LABELS)
    .nullable()
    .describe(
      'What the agent would set right now, kept up to date even while an override suppresses it — so the console can show that the agent disagrees, and so clearing the override restores a current value rather than a stale one.',
    ),
  agentEvaluatedAt: isoTimestamp()
    .nullable()
    .describe(
      'When an agent turn last evaluated this customer. Updated even while an override is in force.',
    ),
  updatedAt: isoTimestamp(),
});

export type CustomerLabelRecord = z.infer<typeof customerLabelSchema>;
export class CustomerLabelDto extends createZodDto(customerLabelSchema) {}

export const setCustomerLabelBodySchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CUSTOMER_LABEL_LENGTH)
    .describe(
      'The label to pin on this customer. `hot`/`warm`/`cold` keeps it in the taxonomy the agent uses; any other value is accepted as a tenant-defined label.',
    ),
});

export type SetCustomerLabelBody = z.infer<typeof setCustomerLabelBodySchema>;
export class SetCustomerLabelBodyDto extends createZodDto(
  setCustomerLabelBodySchema,
) {}
