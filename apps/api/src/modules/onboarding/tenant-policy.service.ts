// Product shell (OnboardingModule owns "policy config" per its own module
// comment): T15's tenant policy CRUD. No HTTP endpoint this pass — per
// the former feature plan's Feature 2.5 scope, "a tenant can be seeded (SQL/script,
// no UI) with a policy row." Feature 6 adds the real admin-only API (T14
// role-gated) on top of this same service, not a replacement for it.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { tenantPolicy } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  TenantPolicyRecord,
  UpsertTenantPolicyInput,
} from './tenant-policy.dto';

@Injectable()
export class TenantPolicyService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Seeds or updates a tenant's policy row. Omitted fields keep their DB default (0.70 threshold, [] forbidden topics) on first insert, or their current value on update. */
  async upsert(
    tenantId: string,
    input: UpsertTenantPolicyInput,
  ): Promise<TenantPolicyRecord> {
    const [existing] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantPolicy)
          .where(eq(tenantPolicy.tenantId, tenantId))
          .limit(1),
      tenantId,
    );

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantPolicy)
          .values({
            tenantId,
            ...(input.confidenceThreshold !== undefined && {
              confidenceThreshold: input.confidenceThreshold,
            }),
            ...(input.forbiddenTopics !== undefined && {
              forbiddenTopics: input.forbiddenTopics,
            }),
            ...(input.tonePersonaOverride !== undefined && {
              tonePersonaOverride: input.tonePersonaOverride,
            }),
            ...(input.rerankEnabled !== undefined && {
              rerankEnabled: input.rerankEnabled,
            }),
            ...(input.stuckTicketThresholdMinutes !== undefined && {
              stuckTicketThresholdMinutes: input.stuckTicketThresholdMinutes,
            }),
          })
          .onConflictDoUpdate({
            target: tenantPolicy.tenantId,
            set: {
              confidenceThreshold:
                input.confidenceThreshold ?? existing?.confidenceThreshold,
              forbiddenTopics:
                input.forbiddenTopics ?? existing?.forbiddenTopics,
              tonePersonaOverride:
                input.tonePersonaOverride !== undefined
                  ? input.tonePersonaOverride
                  : (existing?.tonePersonaOverride ?? null),
              rerankEnabled: input.rerankEnabled ?? existing?.rerankEnabled,
              stuckTicketThresholdMinutes:
                input.stuckTicketThresholdMinutes ??
                existing?.stuckTicketThresholdMinutes,
              updatedAt: new Date(),
            },
          })
          .returning(),
      tenantId,
    );

    return toRecord(row);
  }

  async getForTenant(tenantId: string): Promise<TenantPolicyRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantPolicy)
          .where(eq(tenantPolicy.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

function toRecord(row: typeof tenantPolicy.$inferSelect): TenantPolicyRecord {
  return {
    tenantId: row.tenantId,
    confidenceThreshold: row.confidenceThreshold,
    forbiddenTopics: row.forbiddenTopics,
    tonePersonaOverride: row.tonePersonaOverride,
    rerankEnabled: row.rerankEnabled,
    stuckTicketThresholdMinutes: row.stuckTicketThresholdMinutes,
  };
}
