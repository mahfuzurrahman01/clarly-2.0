import type { AppLoggerService } from '../logger/app-logger.service';
import { sweepTenantsWithBoundedConcurrency } from './sweep-tenants';

function makeLogger(): { logger: AppLoggerService; warn: jest.Mock } {
  const warn = jest.fn();
  return { logger: { warn } as unknown as AppLoggerService, warn };
}

describe('sweepTenantsWithBoundedConcurrency', () => {
  it('returns one result per tenant when every call succeeds', async () => {
    const { logger } = makeLogger();
    const results = await sweepTenantsWithBoundedConcurrency(
      ['t1', 't2', 't3'],
      (tenantId) => Promise.resolve(`ok:${tenantId}`),
      { logger, sweepName: 'test-sweep' },
    );

    expect(results.map((r) => r.value).sort()).toEqual([
      'ok:t1',
      'ok:t2',
      'ok:t3',
    ]);
  });

  // The bug this fixes: Promise.all's fail-fast semantics meant one tenant's
  // rejection took the whole batch down. This is the regression test for
  // that — every OTHER tenant must still get a result.
  it('isolates a single tenant failure — every other tenant still gets a result', async () => {
    const { logger, warn } = makeLogger();
    const results = await sweepTenantsWithBoundedConcurrency(
      ['t1', 't2', 't3'],
      (tenantId) =>
        tenantId === 't2'
          ? Promise.reject(new Error('connection timeout'))
          : Promise.resolve(`ok:${tenantId}`),
      { logger, sweepName: 'test-sweep' },
    );

    expect(results.map((r) => r.tenantId).sort()).toEqual(['t1', 't3']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('t2'),
      'test-sweep',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('connection timeout'),
      'test-sweep',
    );
  });

  it('never has more than `concurrency` calls in flight at once', async () => {
    const { logger } = makeLogger();
    let inFlight = 0;
    let maxInFlight = 0;

    await sweepTenantsWithBoundedConcurrency(
      ['t1', 't2', 't3', 't4', 't5', 't6'],
      async (tenantId) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return tenantId;
      },
      { logger, sweepName: 'test-sweep', concurrency: 2 },
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('defaults to DEFAULT_TENANT_SWEEP_CONCURRENCY when unset', async () => {
    const { logger } = makeLogger();
    let inFlight = 0;
    let maxInFlight = 0;

    await sweepTenantsWithBoundedConcurrency(
      Array.from({ length: 10 }, (_, i) => `t${i}`),
      async (tenantId) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return tenantId;
      },
      { logger, sweepName: 'test-sweep' },
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('returns an empty array for an empty tenant list, without calling fn', async () => {
    const { logger } = makeLogger();
    const fn = jest.fn();

    const results = await sweepTenantsWithBoundedConcurrency([], fn, {
      logger,
      sweepName: 'test-sweep',
    });

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
