// F25 D1.2 gate 1: the registry gate.
//
// Without an enabled `tenant_tools` row, `ToolExecutionService.authorize()`
// throws `ToolScopeViolation` and the tool is never rendered into L3 — the
// model is not told `create_order` exists. That is the strongest version of
// "a tenant that has not opted in cannot have an order created by the agent
// under any prompt" (exit criterion 3): there is nothing to prompt-inject
// toward.
//
// This mirrors `CatalogToolSeederService`, including its idempotent
// upsert-by-(tenant, name) — with one deliberate difference: it is NOT called
// at signup. It is driven by `tenant_order_settings.mode`, and only ever by
// `OrderSettingsService`.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import type { OrderMode } from '../persistence/drizzle/tenant-order-settings.table';
import { createOrderToolDefinition } from './create-order.tool';

@Injectable()
export class OrderToolSeederService {
  constructor(
    private readonly toolRegistry: TenantToolRegistryService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * The single entry point: hands the registry the mode and lets it decide.
   * Enabled for `human_approval` and `auto`, disabled for `disabled` —
   * DISABLED, not deleted, so the row's history (and any tenant-level
   * customisation of the description) survives a merchant switching ordering
   * off for a week. `isToolEnabledForTenant` filters on `enabled`, so a
   * disabled row is exactly as unreachable as an absent one.
   */
  async syncForMode(tenantId: string, mode: OrderMode): Promise<void> {
    await this.toolRegistry.upsertTool(tenantId, {
      name: createOrderToolDefinition.name,
      description: createOrderToolDefinition.description,
      jsonSchema: createOrderToolDefinition.jsonSchema,
      enabled: mode !== 'disabled',
    });
  }

  /**
   * Best-effort variant for the settings endpoint, where the mode change is
   * already committed. A registry row that failed to write leaves the tenant
   * MORE restricted than they asked for (the tool stays unreachable), never
   * less — which is the right direction to fail in for a gate on real money.
   * The execution gate (D1.2 gate 2) is what keeps a STALE enabled row safe
   * in the other direction.
   */
  async syncForModeBestEffort(
    tenantId: string,
    mode: OrderMode,
  ): Promise<void> {
    try {
      await this.syncForMode(tenantId, mode);
    } catch (error) {
      this.logger.error(
        `syncing the create_order tool row for tenant ${tenantId} (mode ${mode}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        'OrderToolSeederService',
      );
    }
  }
}
