// Feature 20 (Product Catalog & Stock): enables `lookup_product` for a
// tenant.
//
// Without a row in `tenant_tools`, ToolExecutionService.authorize() rejects
// every call with ToolScopeViolation and the tool never reaches L3 — so a
// tool that nothing ever seeds is a tool the agent can never call, however
// complete the executor is. Nothing wrote that row before this service: F20
// shipped a fully built tool that was unreachable for every tenant.
//
// Two halves, both needed:
//   - NEW tenants: TenantProvisioningService calls seedForTenant() at signup.
//   - EXISTING tenants: migration 0053 backfills the same row.
// The jsonSchema written here is `lookupProductToolDefinition.jsonSchema`
// verbatim — the same object ToolExecutionService validates against (A2's
// "same object, not a parallel definition"), so the backfill and this
// service cannot drift from what execution enforces.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { lookupProductToolDefinition } from './catalog-product.tool';

@Injectable()
export class CatalogToolSeederService {
  constructor(
    private readonly toolRegistry: TenantToolRegistryService,
    private readonly logger: AppLoggerService,
  ) {}

  /** Idempotent (upsert by tenant+name) — safe to call on every signup and to re-run. */
  async seedForTenant(tenantId: string): Promise<void> {
    await this.toolRegistry.upsertTool(tenantId, {
      name: lookupProductToolDefinition.name,
      description: lookupProductToolDefinition.description,
      jsonSchema: lookupProductToolDefinition.jsonSchema,
      enabled: true,
    });
  }

  /**
   * Best-effort variant for callers (signup) where the tenant is already
   * committed: a tool row that failed to write is a degraded agent, not a
   * reason to fail the workspace creation — same posture as the local-trial
   * write in TenantProvisioningService.
   */
  async seedForTenantBestEffort(tenantId: string): Promise<void> {
    try {
      await this.seedForTenant(tenantId);
    } catch (error) {
      this.logger.error(
        `seeding the lookup_product tool for tenant ${tenantId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'CatalogToolSeederService',
      );
    }
  }
}
