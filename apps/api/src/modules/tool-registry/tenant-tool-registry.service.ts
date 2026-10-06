// Agent (AI-owned, A2): tenant tool registry -> JSON schema for L3. Every
// query goes through TenantContextService.withTenantTx() (never a direct
// DB handle — that's Rule 4, enforced by eslint.module-boundaries.mjs), so
// tenant_tools' RLS policy (T5, docs/decisions/F1-security.md) is the
// actual isolation boundary here, not application-level filtering. This
// service's `tenantId` parameters exist for callers that resolve tenant
// before an AsyncLocalStorage context is established (e.g. seeding during
// onboarding); withTenantTx() still sets the RLS GUC either way.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { tenantTools } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { PromptToolSchema, TenantToolRecord } from './tenant-tool.dto';

export interface UpsertTenantToolInput {
  name: string;
  description: string;
  jsonSchema: unknown;
  enabled?: boolean;
}

@Injectable()
export class TenantToolRegistryService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Enabled tools only — what a tenant's agent loop is actually allowed to call and what L3 should show it. */
  async listEnabledTools(tenantId: string): Promise<TenantToolRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantTools)
          .where(
            and(
              eq(tenantTools.tenantId, tenantId),
              eq(tenantTools.enabled, true),
            ),
          ),
      tenantId,
    );
    return rows.map(toRecord);
  }

  /** L3-ready shape (A2) — name/description/parameters per tenant's enabled tools. */
  async getPromptToolSchemas(tenantId: string): Promise<PromptToolSchema[]> {
    const tools = await this.listEnabledTools(tenantId);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    }));
  }

  /** True only if `name` is one of this tenant's own ENABLED tools — the check ToolExecutionModule.authorize() (T2) is built on. */
  async isToolEnabledForTenant(
    tenantId: string,
    name: string,
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: tenantTools.id })
          .from(tenantTools)
          .where(
            and(
              eq(tenantTools.tenantId, tenantId),
              eq(tenantTools.name, name),
              eq(tenantTools.enabled, true),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows.length > 0;
  }

  /** Onboarding-time seeding (Feature 6 wires the real caller); upserts by (tenantId, name) — the table's unique constraint. */
  async upsertTool(
    tenantId: string,
    input: UpsertTenantToolInput,
  ): Promise<TenantToolRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantTools)
          .values({
            tenantId,
            name: input.name,
            description: input.description,
            jsonSchema: input.jsonSchema,
            enabled: input.enabled ?? true,
          })
          .onConflictDoUpdate({
            target: [tenantTools.tenantId, tenantTools.name],
            set: {
              description: input.description,
              jsonSchema: input.jsonSchema,
              enabled: input.enabled ?? true,
              updatedAt: new Date(),
            },
          })
          .returning(),
      tenantId,
    );
    return toRecord(row);
  }
}

function toRecord(row: typeof tenantTools.$inferSelect): TenantToolRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    jsonSchema: row.jsonSchema,
    enabled: row.enabled,
  };
}
