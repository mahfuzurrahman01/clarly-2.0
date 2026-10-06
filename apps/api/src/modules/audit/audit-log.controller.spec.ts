import type { TenantAuthContext } from '../auth/jwt-claims';
import { AuditLogController } from './audit-log.controller';
import type { AuditLogService } from './audit-log.service';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function makeAuth(tenantId = TENANT_A): TenantAuthContext {
  return {
    userId: 'user-1',
    tenantId,
    role: 'authenticated',
    appRole: 'admin',
  };
}

function makeHarness() {
  const list = jest.fn().mockResolvedValue([]);
  return {
    controller: new AuditLogController({ list } as unknown as AuditLogService),
    list,
  };
}

describe('AuditLogController.list()', () => {
  it('returns the tenant’s entries', async () => {
    const { controller, list } = makeHarness();
    const entry = { id: 'entry-1', actorUserId: 'user-1' };
    list.mockResolvedValue([entry]);

    await expect(controller.list(makeAuth(), { limit: 50 })).resolves.toEqual([
      entry,
    ]);
  });

  // Same posture as every other read here: the tenant comes off the verified
  // token, never off a parameter a caller controls.
  it('scopes the read to the token’s tenant', async () => {
    const { controller, list } = makeHarness();

    await controller.list(makeAuth(TENANT_B), { limit: 50 });

    expect(list).toHaveBeenCalledWith(TENANT_B, { limit: 50 });
  });

  it('passes the keyset cursor through', async () => {
    const { controller, list } = makeHarness();
    const before = new Date('2026-08-22T10:00:00Z');

    await controller.list(makeAuth(), { limit: 25, before });

    expect(list).toHaveBeenCalledWith(TENANT_A, { limit: 25, before });
  });
});
