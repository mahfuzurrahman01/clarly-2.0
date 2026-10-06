// F26 (D4, D10): a tool nothing seeds is a tool the agent can never call.
//
// The seeded schema must be the SAME object ToolExecutionService validates
// against — a parallel copy is how the enforced schema and the one the model
// is shown drift apart.
import type { AppLoggerService } from '../core';
import type { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { CourierToolSeederService } from './courier-tool-seeder.service';
import { trackOrderToolDefinition } from './track-order.tool';
import { TOOL_DEFINITIONS } from '../tool-execution/tool-definitions';

function makeService(upsertTool = jest.fn().mockResolvedValue(undefined)) {
  const error = jest.fn();
  const service = new CourierToolSeederService(
    { upsertTool } as unknown as TenantToolRegistryService,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error,
      debug: jest.fn(),
    } as unknown as AppLoggerService,
  );
  return { service, upsertTool, error };
}

describe('CourierToolSeederService', () => {
  it('enables track_order with the tool definition’s own schema', async () => {
    const { service, upsertTool } = makeService();

    await service.seedForTenant('tenant-a');

    expect(upsertTool).toHaveBeenCalledWith('tenant-a', {
      name: 'track_order',
      description: trackOrderToolDefinition.description,
      jsonSchema: trackOrderToolDefinition.jsonSchema,
      enabled: true,
    });
  });

  // The signup caller has an already-committed tenant: a missing tool row is
  // a degraded agent, not a reason to fail the workspace creation.
  it('swallows and logs a failure on the best-effort path', async () => {
    const { service, error } = makeService(
      jest.fn().mockRejectedValue(new Error('db down')),
    );

    await expect(
      service.seedForTenantBestEffort('tenant-a'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('is registered in TOOL_DEFINITIONS as the same object', () => {
    // Registration and seeding reading two different definitions is exactly
    // the bug this asserts against.
    expect(TOOL_DEFINITIONS.track_order).toBe(trackOrderToolDefinition);
  });
});
