// F20 retroactive review (2026-09-21): `lookup_product` was fully built and
// never enabled for anyone — no code path wrote the tenant_tools row, so
// ToolExecutionService.authorize() rejected every call with
// ToolScopeViolation. These tests pin the seeding path that fixes that.
import type { AppLoggerService } from '../core';
import type { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { CatalogToolSeederService } from './catalog-tool-seeder.service';
import { lookupProductToolDefinition } from './catalog-product.tool';

const TENANT = '11111111-1111-1111-1111-111111111111';

function makeHarness() {
  const upsertTool = jest.fn().mockResolvedValue(undefined);
  const logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
  const service = new CatalogToolSeederService(
    { upsertTool } as unknown as TenantToolRegistryService,
    logger as unknown as AppLoggerService,
  );
  return { service, upsertTool, logger };
}

describe('CatalogToolSeederService', () => {
  it('enables lookup_product for the tenant with the SAME schema execution validates against', async () => {
    const { service, upsertTool } = makeHarness();

    await service.seedForTenant(TENANT);

    expect(upsertTool).toHaveBeenCalledWith(TENANT, {
      name: 'lookup_product',
      description: lookupProductToolDefinition.description,
      jsonSchema: lookupProductToolDefinition.jsonSchema,
      enabled: true,
    });
    // A2's "same object, not a parallel definition": what is written to
    // tenant_tools is `lookupProductToolDefinition` itself, which is also the
    // entry ToolExecutionService's TOOL_DEFINITIONS registers — asserted
    // there rather than here, so this module's tests stay independent of the
    // (separately committed) tool-execution wiring.
  });

  it('carries the D5 anti-hallucination contract into the tenant_tools row', async () => {
    const { service, upsertTool } = makeHarness();

    await service.seedForTenant(TENANT);

    const calls = upsertTool.mock.calls as unknown as Array<
      [string, { description: string }]
    >;
    const { description } = calls[0][1];
    expect(description).toMatch(/only from this tool's results/i);
    expect(description).toMatch(/escalate/i);
  });

  it('surfaces a seeding failure to the caller when called directly', async () => {
    const { service, upsertTool } = makeHarness();
    upsertTool.mockRejectedValue(new Error('db down'));

    await expect(service.seedForTenant(TENANT)).rejects.toThrow('db down');
  });

  // Signup has already committed the tenant by the time this runs: a missing
  // tool row is a degraded agent, not a reason to fail the workspace.
  it('logs and swallows a failure in the best-effort form used at signup', async () => {
    const { service, upsertTool, logger } = makeHarness();
    upsertTool.mockRejectedValue(new Error('db down'));

    await expect(
      service.seedForTenantBestEffort(TENANT),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(TENANT),
      'CatalogToolSeederService',
    );
  });
});
