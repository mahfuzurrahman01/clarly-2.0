import { NotFoundException } from '@nestjs/common';
import type { TenantAuthContext } from '../auth/jwt-claims';
import type { TenantDirectoryService } from './tenant-directory.service';
import { TenantController } from './tenant.controller';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function makeAuth(overrides: Partial<TenantAuthContext> = {}) {
  return {
    userId: 'user-1',
    tenantId: TENANT_A,
    role: 'authenticated',
    appRole: 'admin' as const,
    ...overrides,
  };
}

function makeService(entry: { id: string; name: string } | null) {
  const getById = jest.fn().mockResolvedValue(entry);
  return {
    service: { getById } as unknown as TenantDirectoryService,
    getById,
  };
}

describe('TenantController.get()', () => {
  it('returns the calling tenant', async () => {
    const { service } = makeService({ id: TENANT_A, name: 'Acme Support' });
    const controller = new TenantController(service);

    await expect(controller.get(makeAuth())).resolves.toEqual({
      id: TENANT_A,
      name: 'Acme Support',
    });
  });

  // The whole security posture of this endpoint rests on the tenant id coming
  // off the verified token. `tenants` has no RLS, so if a future refactor ever
  // sources it from a path or query parameter instead, nothing in the database
  // stops the caller reading another workspace. This asserts the wiring.
  it('reads the tenant id from the verified token, not from any parameter', async () => {
    const { service, getById } = makeService({
      id: TENANT_A,
      name: 'Acme Support',
    });
    const controller = new TenantController(service);

    await controller.get(makeAuth({ tenantId: TENANT_B }));

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith(TENANT_B);
  });

  // Both roles render the sidebar, so this route is deliberately ungated —
  // an agent-role token must get a real answer, not a 403.
  it('serves the agent role, not just admin', async () => {
    const { service } = makeService({ id: TENANT_A, name: 'Acme Support' });
    const controller = new TenantController(service);

    await expect(
      controller.get(makeAuth({ appRole: 'agent' })),
    ).resolves.toEqual({ id: TENANT_A, name: 'Acme Support' });
  });

  // A token whose tenant row is gone means a stale session. 404 tells the
  // console to send the user back through sign-in; a 500 would read as an
  // outage and get retried.
  it('throws NotFoundException when the tenant row is gone', async () => {
    const { service } = makeService(null);
    const controller = new TenantController(service);

    await expect(controller.get(makeAuth())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
