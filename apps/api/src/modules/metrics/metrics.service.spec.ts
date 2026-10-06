import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { MetricsService } from './metrics.service';

const TENANT_A = 'tenant-a';
const FROM = new Date('2026-08-01T00:00:00Z');
const TO = new Date('2026-08-31T23:59:59Z');

/** Chainable fake matching whatever subset of the query-builder methods the test needs — resolves once a terminal `.then`-able promise method is reached, via the `resolveWith` marker. */
function chain(
  resolveWith: unknown,
): Record<string, (...args: never[]) => unknown> {
  const node: Record<string, (...args: never[]) => unknown> = {
    from: () => node,
    where: () => node,
    groupBy: () => node,
    select: () => node,
    then: (onFulfilled: (value: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(resolveWith).then(onFulfilled),
  };
  return node;
}

function makeTenantContext(response: unknown[]): {
  tenantContext: TenantContextService;
} {
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = { select: () => chain(response) };
    return fn(tx);
  });
  return { tenantContext: { withTenantTx } as unknown as TenantContextService };
}

describe('MetricsService.getEscalationBreakdown()', () => {
  it('returns a count per escalation reason among escalated outcomes closed within the date range', async () => {
    const { tenantContext } = makeTenantContext([
      { escalationReason: 'TOOL_FAILURE', count: 3 },
      { escalationReason: 'UNSUPPORTED_MEDIA', count: 1 },
    ]);
    const service = new MetricsService(tenantContext);

    const result = await service.getEscalationBreakdown(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({ TOOL_FAILURE: 3, UNSUPPORTED_MEDIA: 1 });
  });

  it('returns an empty object when nothing escalated in range', async () => {
    const { tenantContext } = makeTenantContext([]);
    const service = new MetricsService(tenantContext);

    const result = await service.getEscalationBreakdown(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({});
  });
});

describe('MetricsService.getResolutionRate()', () => {
  it('computes the rate from escalated/non-escalated outcome counts closed within the date range', async () => {
    const { tenantContext } = makeTenantContext([
      { escalated: false, count: 7 },
      { escalated: true, count: 3 },
    ]);
    const service = new MetricsService(tenantContext);

    const result = await service.getResolutionRate(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({
      from: FROM,
      to: TO,
      totalConversations: 10,
      resolvedConversations: 7,
      resolutionRate: 0.7,
    });
  });

  it('counts only escalated: false outcomes as resolved', async () => {
    const { tenantContext } = makeTenantContext([
      { escalated: true, count: 5 },
    ]);
    const service = new MetricsService(tenantContext);

    const result = await service.getResolutionRate(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result.resolvedConversations).toBe(0);
    expect(result.totalConversations).toBe(5);
  });

  it('returns a 0 rate (not NaN) when no conversations closed in range', async () => {
    const { tenantContext } = makeTenantContext([]);
    const service = new MetricsService(tenantContext);

    const result = await service.getResolutionRate(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({
      from: FROM,
      to: TO,
      totalConversations: 0,
      resolvedConversations: 0,
      resolutionRate: 0,
    });
  });

  it('reports a 100% rate when every closed conversation resolved without escalation', async () => {
    const { tenantContext } = makeTenantContext([
      { escalated: false, count: 4 },
    ]);
    const service = new MetricsService(tenantContext);

    const result = await service.getResolutionRate(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result.resolutionRate).toBe(1);
  });
});

describe('MetricsService.getFirstResponseTime()', () => {
  it('rounds the interpolated percentiles and reports the denominator behind them', async () => {
    const { tenantContext } = makeTenantContext([
      { measured: 12, medianMs: 41250.5, p90Ms: 180400.2 },
    ]);
    const service = new MetricsService(tenantContext);

    const result = await service.getFirstResponseTime(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({
      from: FROM,
      to: TO,
      measuredConversations: 12,
      medianMs: 41251,
      p90Ms: 180400,
    });
  });

  it('reports null, never 0, when no conversation in the window was ever replied to', async () => {
    const { tenantContext } = makeTenantContext([
      { measured: 0, medianMs: null, p90Ms: null },
    ]);
    const service = new MetricsService(tenantContext);

    const result = await service.getFirstResponseTime(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result.measuredConversations).toBe(0);
    expect(result.medianMs).toBeNull();
    expect(result.p90Ms).toBeNull();
  });

  it('survives an empty result set (a tenant with no closed conversations at all)', async () => {
    const { tenantContext } = makeTenantContext([]);
    const service = new MetricsService(tenantContext);

    const result = await service.getFirstResponseTime(TENANT_A, {
      from: FROM,
      to: TO,
    });

    expect(result).toEqual({
      from: FROM,
      to: TO,
      measuredConversations: 0,
      medianMs: null,
      p90Ms: null,
    });
  });
});
