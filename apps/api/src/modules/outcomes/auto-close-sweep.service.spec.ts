import type { AppConfigService } from '../core';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AutoCloseSweepService } from './auto-close-sweep.service';
import type { ConversationOutcomeService } from './conversation-outcome.service';
import type { AppLoggerService } from '../core';

function makeLogger(): AppLoggerService {
  return { warn: jest.fn() } as unknown as AppLoggerService;
}

const NOW = new Date('2026-08-13T12:00:00Z');

/**
 * `sweepTenant()` builds two correlated subqueries (hasTicket, hasOutcome)
 * before the final outer query — all three go through the same
 * `tx.select()` call. The two subqueries are only ever passed into
 * `notExists()` for SQL-condition construction, never awaited directly,
 * so they just need to return *some* chainable object; only the third
 * (outer) call needs to resolve to the candidate rows.
 */
function makeTenantContext(candidateRows: Array<{ id: string }>): {
  tenantContext: TenantContextService;
} {
  let selectCall = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => {
        const isOuterQuery = selectCall === 2;
        selectCall++;
        return {
          from: () => ({
            where: () =>
              isOuterQuery
                ? Promise.resolve(candidateRows)
                : { fakeSubquery: true },
          }),
        };
      },
    };
    return fn(tx);
  });
  return { tenantContext: { withTenantTx } as unknown as TenantContextService };
}

function makeHarness(
  candidateRows: Array<{ id: string }>,
  tenantIds: string[] = ['tenant-a'],
): {
  service: AutoCloseSweepService;
  recordAutoResolved: jest.Mock;
} {
  const persistence = {
    runAdminQuery: jest.fn((fn: (db: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => Promise.resolve(tenantIds.map((id) => ({ id }))),
        }),
      }),
    ),
  } as unknown as PersistenceService;

  const { tenantContext } = makeTenantContext(candidateRows);
  const recordAutoResolved = jest.fn().mockResolvedValue(undefined);
  const conversationOutcome = {
    recordAutoResolved,
  } as unknown as ConversationOutcomeService;
  const config = { autoCloseInactivityHours: 24 } as AppConfigService;

  const service = new AutoCloseSweepService(
    persistence,
    tenantContext,
    conversationOutcome,
    config,
    makeLogger(),
  );

  return { service, recordAutoResolved };
}

describe('AutoCloseSweepService.sweepAllTenants()', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records an auto-resolved outcome for each candidate conversation found', async () => {
    const { service, recordAutoResolved } = makeHarness([
      { id: 'conv-1' },
      { id: 'conv-2' },
    ]);

    const closed = await service.sweepAllTenants();

    expect(closed).toHaveLength(2);
    expect(recordAutoResolved).toHaveBeenCalledTimes(2);
    expect(recordAutoResolved).toHaveBeenCalledWith(
      'tenant-a',
      'conv-1',
      expect.any(Date),
    );
    expect(recordAutoResolved).toHaveBeenCalledWith(
      'tenant-a',
      'conv-2',
      expect.any(Date),
    );
  });

  it('records nothing when no conversation qualifies', async () => {
    const { service, recordAutoResolved } = makeHarness([]);

    const closed = await service.sweepAllTenants();

    expect(closed).toEqual([]);
    expect(recordAutoResolved).not.toHaveBeenCalled();
  });
});
