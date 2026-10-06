import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * T4's stated default, used when a tenant has no `tenant_policy` row at all —
 * the DB column defaults to the same value once a row exists. Lives with the
 * policy contract so the alerting sweep and the console API read one constant
 * rather than two copies that can drift apart.
 */
export const DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES = 15;

export const tenantPolicyRecordSchema = z.object({
  tenantId: z.string().uuid(),
  confidenceThreshold: z.number(),
  forbiddenTopics: z.array(z.string()),
  tonePersonaOverride: z.string().nullable(),
  /** D4's per-tenant rerank flag — column added in Feature 3/A1's migration, exposed here in Feature 4 once AgentRuntime actually needed to read it. */
  rerankEnabled: z.boolean(),
  /** T4: "unclaimed after N minutes (tenant-configurable, default 15)." */
  stuckTicketThresholdMinutes: z.number().int(),
});

export type TenantPolicyRecord = z.infer<typeof tenantPolicyRecordSchema>;

export class TenantPolicyRecordDto extends createZodDto(
  tenantPolicyRecordSchema,
) {}

export interface UpsertTenantPolicyInput {
  confidenceThreshold?: number;
  forbiddenTopics?: string[];
  tonePersonaOverride?: string | null;
  rerankEnabled?: boolean;
  stuckTicketThresholdMinutes?: number;
}
