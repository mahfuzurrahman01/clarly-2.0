import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantToolRegistryService } from './tenant-tool-registry.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

describe('TenantToolRegistryService', () => {
  it('getPromptToolSchemas() maps DB rows to the name/description/parameters shape', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([
      {
        id: 'row-1',
        tenantId: TENANT_A,
        name: 'echo',
        description: 'Echoes a message',
        jsonSchema: { type: 'object' },
        enabled: true,
      },
    ]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    const schemas = await service.getPromptToolSchemas(TENANT_A);

    expect(schemas).toEqual([
      {
        name: 'echo',
        description: 'Echoes a message',
        parameters: { type: 'object' },
      },
    ]);
  });

  it('isToolEnabledForTenant() reflects whether withTenantTx() returned any rows', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    await expect(
      service.isToolEnabledForTenant(TENANT_A, 'echo'),
    ).resolves.toBe(false);
  });

  it('every read/write goes through withTenantTx() with the caller-supplied tenantId, never a bare db call', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    await service.listEnabledTools(TENANT_A);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  it('upsertTool() defaults enabled to true when not specified and returns the mapped record', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([
      {
        id: 'row-1',
        tenantId: TENANT_A,
        name: 'echo',
        description: 'Echoes a message',
        jsonSchema: { type: 'object' },
        enabled: true,
      },
    ]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    const record = await service.upsertTool(TENANT_A, {
      name: 'echo',
      description: 'Echoes a message',
      jsonSchema: { type: 'object' },
    });

    expect(record).toEqual({
      id: 'row-1',
      tenantId: TENANT_A,
      name: 'echo',
      description: 'Echoes a message',
      jsonSchema: { type: 'object' },
      enabled: true,
    });
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  it('getPromptToolSchemas() returns an empty array when the tenant has no enabled tools', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    await expect(service.getPromptToolSchemas(TENANT_A)).resolves.toEqual([]);
  });

  it('isToolEnabledForTenant() calls through the real query chain (and/eq/limit), not just a canned resolve', async () => {
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ id: 'row-1' }]) }),
          }),
        }),
      };
      return fn(tx);
    });
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    await expect(
      service.isToolEnabledForTenant(TENANT_A, 'echo'),
    ).resolves.toBe(true);
  });

  it('upsertTool() calls through the real insert/onConflictDoUpdate chain and respects an explicit enabled: false', async () => {
    const row = {
      id: 'row-1',
      tenantId: TENANT_A,
      name: 'echo',
      description: 'Disabled tool',
      jsonSchema: { type: 'object' },
      enabled: false,
    };
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([row]),
            }),
          }),
        }),
      };
      return fn(tx);
    });
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    const record = await service.upsertTool(TENANT_A, {
      name: 'echo',
      description: 'Disabled tool',
      jsonSchema: { type: 'object' },
      enabled: false,
    });

    expect(record).toEqual(row);
  });

  it('listEnabledTools() calls through the real select/from/where chain', async () => {
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: () => ({
          from: () => ({ where: () => Promise.resolve([]) }),
        }),
      };
      return fn(tx);
    });
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const service = new TenantToolRegistryService(tenantContext);

    await expect(service.listEnabledTools(TENANT_A)).resolves.toEqual([]);
  });
});
