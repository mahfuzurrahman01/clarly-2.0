import type { TenantAuthContext } from '../auth/jwt-claims';
import type { TenantPolicyRecord } from './tenant-policy.dto';
import type { AppLoggerService } from '../core';
import type { AgentManagementService } from '../agent-config/agent-management.service';
import { TenantPolicyController } from './tenant-policy.controller';
import type { TenantPolicyService } from './tenant-policy.service';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

function makeRecord(
  overrides: Partial<TenantPolicyRecord> = {},
): TenantPolicyRecord {
  return {
    tenantId: 'tenant-a',
    confidenceThreshold: 0.7,
    forbiddenTopics: [],
    tonePersonaOverride: null,
    rerankEnabled: false,
    stuckTicketThresholdMinutes: 15,
    ...overrides,
  };
}

function makeController(): {
  controller: TenantPolicyController;
  tenantPolicy: { getForTenant: jest.Mock; upsert: jest.Mock };
  applyLegacyPolicy: jest.Mock;
  warn: jest.Mock;
} {
  const tenantPolicy = { getForTenant: jest.fn(), upsert: jest.fn() };
  const applyLegacyPolicy = jest.fn().mockResolvedValue(true);
  const warn = jest.fn();
  const controller = new TenantPolicyController(
    tenantPolicy as unknown as TenantPolicyService,
    { applyLegacyPolicy } as unknown as AgentManagementService,
    { warn } as unknown as AppLoggerService,
  );
  return { controller, tenantPolicy, applyLegacyPolicy, warn };
}

describe('TenantPolicyController', () => {
  it("get() reads the caller's own tenant policy", async () => {
    const { controller, tenantPolicy } = makeController();
    const record = makeRecord();
    tenantPolicy.getForTenant.mockResolvedValue(record);

    await expect(controller.get(AUTH)).resolves.toBe(record);
    expect(tenantPolicy.getForTenant).toHaveBeenCalledWith('tenant-a');
  });

  it('get() returns null when no policy row exists yet', async () => {
    const { controller, tenantPolicy } = makeController();
    tenantPolicy.getForTenant.mockResolvedValue(null);

    await expect(controller.get(AUTH)).resolves.toBeNull();
  });

  it("upsert() writes to the caller's own tenant, forwarding the validated body", async () => {
    const { controller, tenantPolicy } = makeController();
    const updated = makeRecord({ confidenceThreshold: 0.85 });
    tenantPolicy.upsert.mockResolvedValue(updated);

    const result = await controller.upsert(AUTH, {
      confidenceThreshold: 0.85,
    });

    expect(result).toBe(updated);
    expect(tenantPolicy.upsert).toHaveBeenCalledWith('tenant-a', {
      confidenceThreshold: 0.85,
    });
  });
});

describe('TenantPolicyController write-through (F9)', () => {
  it("applies the edit to the tenant's published agent, not only to the legacy row", async () => {
    const { controller, tenantPolicy, applyLegacyPolicy } = makeController();
    tenantPolicy.upsert.mockResolvedValue({ tenantId: 'tenant-a' });

    await controller.upsert(AUTH, { confidenceThreshold: 0.55 });

    // Without this the tenant would get a 200 and nothing a customer ever
    // sees would change — the respond path reads agent configuration now.
    expect(applyLegacyPolicy).toHaveBeenCalledWith('tenant-a', AUTH.userId, {
      confidenceThreshold: 0.55,
    });
    expect(tenantPolicy.upsert).toHaveBeenCalled();
  });

  it('still writes the policy row and warns when there is no single agent to apply it to', async () => {
    const { controller, tenantPolicy, applyLegacyPolicy, warn } =
      makeController();
    applyLegacyPolicy.mockResolvedValue(false);
    tenantPolicy.upsert.mockResolvedValue({ tenantId: 'tenant-a' });

    await controller.upsert(AUTH, { stuckTicketThresholdMinutes: 25 });

    expect(tenantPolicy.upsert).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no single published agent'),
      'TenantPolicyController',
    );
  });
});
