import type { TenantAuthContext } from '../auth/jwt-claims';
import { TenantLifecycleController } from './tenant-lifecycle.controller';
import type { TenantLifecycleService } from './tenant-lifecycle.service';
import { recordingAudit } from '../audit/__fixtures__/recording-audit';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

function makeController() {
  const lifecycle = {
    close: jest.fn(),
    reopen: jest.fn(),
    getClosure: jest.fn(),
  };
  return {
    controller: new TenantLifecycleController(
      lifecycle as unknown as TenantLifecycleService,
    ),
    lifecycle,
  };
}

const noAudit = { describe: () => {} };

describe('TenantLifecycleController', () => {
  it('closes the caller’s own workspace and returns the erasure deadline', async () => {
    const { controller, lifecycle } = makeController();
    const purgeAfter = new Date('2026-09-21T00:00:00Z');
    lifecycle.close.mockResolvedValue({
      tenantId: 'tenant-a',
      closedAt: new Date(),
      purgeAfter,
    });

    const result = await controller.close(AUTH, noAudit);

    expect(lifecycle.close).toHaveBeenCalledWith('tenant-a');
    expect(result.purgeAfter).toEqual(purgeAfter);
  });

  // Closing an account is the first thing a security review asks about.
  it('records the erasure deadline in the audit trail', async () => {
    const { controller, lifecycle } = makeController();
    lifecycle.close.mockResolvedValue({
      tenantId: 'tenant-a',
      closedAt: new Date(),
      purgeAfter: new Date('2026-09-21T00:00:00Z'),
    });
    const audit = recordingAudit();

    await controller.close(AUTH, audit);

    expect(audit.described[0]).toContain('Closed the workspace');
    expect(audit.recorded[0]).toMatchObject({
      key: 'workspace.closed',
      params: { purgeAfter: '2026-09-21T00:00:00.000Z' },
    });
  });

  it('reopens and says so in the audit trail', async () => {
    const { controller, lifecycle } = makeController();
    lifecycle.reopen.mockResolvedValue({
      tenantId: 'tenant-a',
      closedAt: null,
      purgeAfter: null,
    });
    const audit = recordingAudit();

    await controller.reopen(AUTH, audit);

    expect(lifecycle.reopen).toHaveBeenCalledWith('tenant-a');
    expect(audit.described[0]).toContain('Reopened the workspace');
    expect(audit.recorded[0]).toMatchObject({
      key: 'workspace.reopened',
      params: {},
    });
  });

  it('reports closure status for the calling tenant only', async () => {
    const { controller, lifecycle } = makeController();
    lifecycle.getClosure.mockResolvedValue(null);

    await controller.closure(AUTH);

    expect(lifecycle.getClosure).toHaveBeenCalledWith('tenant-a');
  });
});
