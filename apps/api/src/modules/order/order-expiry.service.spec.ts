// F25 D1.4: the approval-window sweep.
//
// Properties worth a test: every open tenant is entered and its settings are
// read INSIDE its own tenant transaction (a platform-wide read of the FORCE-RLS
// `tenant_order_settings` table returned nothing — Clarly 2.0 fix), a tenant
// that never enabled ordering is skipped, and each tenant is swept against ITS
// OWN configured window rather than a single global one.
import type { AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { TenantDirectoryService } from '../tenant-context/tenant-directory';
import type { OrderApprovalService } from './order-approval.service';
import { OrderExpiryService } from './order-expiry.service';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const TENANT_C = '00000000-0000-0000-0000-00000000000c';

/**
 * @param tenantIds every open tenant the directory returns
 * @param windows the `tenant_order_settings` rows, keyed by tenant — a tenant
 *   absent here has no settings row
 */
function makeHarness(
  tenantIds: string[],
  windows: Record<string, number | null>,
) {
  const listTenantIds = jest.fn().mockResolvedValue(tenantIds);
  const withTenantTx = jest.fn(
    (fn: (tx: unknown) => Promise<unknown>, tenantId?: string) => {
      const rows =
        tenantId !== undefined && tenantId in windows
          ? [{ approvalWindowHours: windows[tenantId] }]
          : [];
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(rows) }),
          }),
        }),
      };
      return fn(tx);
    },
  );
  const expireOverdue = jest.fn().mockResolvedValue(1);
  const service = new OrderExpiryService(
    { listTenantIds } as unknown as TenantDirectoryService,
    { withTenantTx } as unknown as TenantContextService,
    { expireOverdue } as unknown as OrderApprovalService,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService,
  );
  return { service, listTenantIds, withTenantTx, expireOverdue };
}

describe('OrderExpiryService.sweepAllTenants', () => {
  it('lists open tenants and reads each one’s settings under its own tenant', async () => {
    const { service, listTenantIds, withTenantTx } = makeHarness(
      [TENANT_A, TENANT_B],
      { [TENANT_A]: 24 },
    );

    await service.sweepAllTenants();

    // Customer-facing work: closed workspaces are not swept.
    expect(listTenantIds).toHaveBeenCalledWith();
    expect(withTenantTx).toHaveBeenCalledTimes(2);
    expect(withTenantTx.mock.calls.map((call) => call[1]).sort()).toEqual([
      TENANT_A,
      TENANT_B,
    ]);
  });

  it('expires orders only for tenants that have a settings row', async () => {
    const { service, expireOverdue } = makeHarness([TENANT_A, TENANT_B], {
      [TENANT_A]: 24,
    });

    await service.sweepAllTenants();

    expect(expireOverdue).toHaveBeenCalledTimes(1);
    expect(expireOverdue).toHaveBeenCalledWith(TENANT_A, 24);
  });

  it("uses each tenant's own approval window", async () => {
    const { service, expireOverdue } = makeHarness([TENANT_A, TENANT_B], {
      [TENANT_A]: 1,
      [TENANT_B]: 168,
    });

    await service.sweepAllTenants();

    expect(expireOverdue).toHaveBeenCalledWith(TENANT_A, 1);
    expect(expireOverdue).toHaveBeenCalledWith(TENANT_B, 168);
  });

  it('falls back to 24 hours when the stored window is null', async () => {
    const { service, expireOverdue } = makeHarness([TENANT_A], {
      [TENANT_A]: null,
    });

    await service.sweepAllTenants();

    expect(expireOverdue).toHaveBeenCalledWith(TENANT_A, 24);
  });

  it('returns the total expired across every tenant', async () => {
    const { service } = makeHarness([TENANT_A, TENANT_B, TENANT_C], {
      [TENANT_A]: 24,
      [TENANT_B]: 24,
    });

    await expect(service.sweepAllTenants()).resolves.toBe(2);
  });

  it('does nothing at all when no tenant has ever enabled ordering', async () => {
    const { service, expireOverdue } = makeHarness([TENANT_A, TENANT_B], {});

    await expect(service.sweepAllTenants()).resolves.toBe(0);
    expect(expireOverdue).not.toHaveBeenCalled();
  });

  it('does nothing when there are no tenants', async () => {
    const { service, withTenantTx } = makeHarness([], {});

    await expect(service.sweepAllTenants()).resolves.toBe(0);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('keeps sweeping the rest when one tenant fails', async () => {
    const { service, expireOverdue } = makeHarness([TENANT_A, TENANT_B], {
      [TENANT_A]: 24,
      [TENANT_B]: 24,
    });
    expireOverdue.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(service.sweepAllTenants()).resolves.toBe(1);
  });
});
