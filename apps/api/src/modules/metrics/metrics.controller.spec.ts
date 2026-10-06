import type { TenantAuthContext } from '../auth/jwt-claims';
import type { MetricsService } from './metrics.service';
import type { KnowledgeGapService } from './knowledge-gap.service';
import { MetricsController } from './metrics.controller';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

const FROM = new Date('2026-08-01T00:00:00Z');
const TO = new Date('2026-08-31T23:59:59Z');

function makeController(): {
  controller: MetricsController;
  metrics: { getResolutionRate: jest.Mock; getEscalationBreakdown: jest.Mock };
} {
  const metrics = {
    getResolutionRate: jest.fn(),
    getEscalationBreakdown: jest.fn(),
  };
  const controller = new MetricsController(
    metrics as unknown as MetricsService,
    { getReport: jest.fn() } as unknown as KnowledgeGapService,
  );
  return { controller, metrics };
}

describe('MetricsController', () => {
  it("resolutionRate() scopes the query to the caller's tenant", async () => {
    const { controller, metrics } = makeController();
    const result = {
      from: FROM,
      to: TO,
      totalConversations: 10,
      resolvedConversations: 7,
      resolutionRate: 0.7,
    };
    metrics.getResolutionRate.mockResolvedValue(result);

    await expect(
      controller.resolutionRate(AUTH, { from: FROM, to: TO }),
    ).resolves.toBe(result);
    expect(metrics.getResolutionRate).toHaveBeenCalledWith('tenant-a', {
      from: FROM,
      to: TO,
    });
  });

  it("escalationBreakdown() scopes the query to the caller's tenant", async () => {
    const { controller, metrics } = makeController();
    const result = { TOOL_FAILURE: 2 };
    metrics.getEscalationBreakdown.mockResolvedValue(result);

    await expect(
      controller.escalationBreakdown(AUTH, { from: FROM, to: TO }),
    ).resolves.toBe(result);
    expect(metrics.getEscalationBreakdown).toHaveBeenCalledWith('tenant-a', {
      from: FROM,
      to: TO,
    });
  });
});
