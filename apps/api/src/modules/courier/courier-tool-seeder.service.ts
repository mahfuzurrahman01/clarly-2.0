// F26 (Delivery Tracking): enables `track_order` for a tenant (D4).
//
// Without a row in `tenant_tools`, `ToolExecutionService.authorize()` rejects
// every call with ToolScopeViolation and the tool never reaches L3 — so a
// tool nothing seeds is a tool the agent can never call, however complete the
// executor is. That was F20's bug, and it is why both halves exist:
//   - NEW tenants: TenantProvisioningService calls seedForTenantBestEffort().
//   - EXISTING tenants: migration 0060 backfills the same row, as part of the
//     same migration rather than as a follow-up.
//
// Unlike `create_order`, `track_order` needs no approval gate: it is
// read-only and customer-scoped, it moves no money, and it cannot be made to
// read another customer's data (D4's argument list has no identity field).
//
// The jsonSchema written here is `trackOrderToolDefinition.jsonSchema`
// verbatim — the same object `ToolExecutionService` validates against, so the
// seeded schema and the enforced one cannot drift.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { trackOrderToolDefinition } from './track-order.tool';

@Injectable()
export class CourierToolSeederService {
  constructor(
    private readonly toolRegistry: TenantToolRegistryService,
    private readonly logger: AppLoggerService,
  ) {}

  /** Idempotent (upsert by tenant+name) — safe on every signup and safe to re-run. */
  async seedForTenant(tenantId: string): Promise<void> {
    await this.toolRegistry.upsertTool(tenantId, {
      name: trackOrderToolDefinition.name,
      description: trackOrderToolDefinition.description,
      jsonSchema: trackOrderToolDefinition.jsonSchema,
      enabled: true,
    });
  }

  /**
   * Best-effort variant for signup, where the tenant is already committed: a
   * tool row that failed to write is a degraded agent, not a reason to fail
   * the workspace creation. Same posture as the catalog seeder.
   */
  async seedForTenantBestEffort(tenantId: string): Promise<void> {
    try {
      await this.seedForTenant(tenantId);
    } catch (error) {
      this.logger.error(
        `seeding the track_order tool for tenant ${tenantId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'CourierToolSeederService',
      );
    }
  }
}
