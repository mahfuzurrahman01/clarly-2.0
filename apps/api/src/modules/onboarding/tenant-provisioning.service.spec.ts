import { ConflictException } from '@nestjs/common';
import type { BillingService } from '../billing/billing.service';
import type { CatalogToolSeederService } from '../catalog/catalog-tool-seeder.service';
import type { CourierToolSeederService } from '../courier/courier-tool-seeder.service';
import type { AppConfigService, AppLoggerService } from '../core';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantAuthProvisioningPort } from './ports/tenant-auth-provisioning.port';
import { TenantProvisioningService } from './tenant-provisioning.service';

function makeHarness(configOverrides: Partial<AppConfigService> = {}): {
  service: TenantProvisioningService;
  persistence: { runAdminQuery: jest.Mock };
  provisioning: {
    findAssignedTenantId: jest.Mock;
    assignTenantClaims: jest.Mock;
  };
  billing: { startLocalTrial: jest.Mock };
  catalogToolSeeder: { seedForTenantBestEffort: jest.Mock };
  courierToolSeeder: { seedForTenantBestEffort: jest.Mock };
} {
  const persistence = { runAdminQuery: jest.fn() };
  const provisioning = {
    // Nobody is already provisioned unless a test says so.
    findAssignedTenantId: jest.fn().mockResolvedValue(undefined),
    assignTenantClaims: jest.fn().mockResolvedValue(undefined),
  };
  const billing = { startLocalTrial: jest.fn().mockResolvedValue(undefined) };
  // F20: signup enables the `lookup_product` tool for the new tenant.
  const catalogToolSeeder = {
    seedForTenantBestEffort: jest.fn().mockResolvedValue(undefined),
  };
  // F26: signup enables the `track_order` tool for the new tenant.
  const courierToolSeeder = {
    seedForTenantBestEffort: jest.fn().mockResolvedValue(undefined),
  };
  const logger = {
    error: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  const config = {
    tenantProvisioningProvider: 'none',
    ...configOverrides,
  } as AppConfigService;

  const service = new TenantProvisioningService(
    persistence as unknown as PersistenceService,
    // Only the claim-assignment half is exercised here; the port's other
    // methods are irrelevant to provisioning and are not stubbed.
    provisioning as unknown as TenantAuthProvisioningPort,
    config,
    billing as unknown as BillingService,
    catalogToolSeeder as unknown as CatalogToolSeederService,
    courierToolSeeder as unknown as CourierToolSeederService,
    logger as unknown as AppLoggerService,
  );

  return {
    service,
    persistence,
    provisioning,
    billing,
    catalogToolSeeder,
    courierToolSeeder,
  };
}

describe('TenantProvisioningService.signUp()', () => {
  it('creates a tenant row and assigns the signing-up user as its admin', async () => {
    const { service, persistence, provisioning } = makeHarness();
    // Calls through to the real callback, matching the codebase's
    // established withTenantTx()/runAdminQuery() test pattern — exercises
    // the actual insert().values().returning() query-building code, not
    // just a canned return value.
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          insert: () => ({
            values: () => ({
              returning: () =>
                Promise.resolve([{ id: 'tenant-1', name: 'Acme' }]),
            }),
          }),
        }),
    );

    const result = await service.signUp('user-1', 'Acme');

    expect(result).toEqual({
      tenantId: 'tenant-1',
      tenantName: 'Acme',
      claimsAssigned: false,
    });
    expect(provisioning.assignTenantClaims).toHaveBeenCalledWith(
      'user-1',
      'tenant-1',
      'admin',
    );
  });

  // F20: a tool with no tenant_tools row is a tool the agent can never call
  // (authorize() rejects it), so signup must actually enable lookup_product.
  it('enables the lookup_product agent tool for the new tenant', async () => {
    const { service, persistence, catalogToolSeeder } = makeHarness();
    persistence.runAdminQuery.mockResolvedValue([
      { id: 'tenant-1', name: 'Acme' },
    ]);

    await service.signUp('user-1', 'Acme');

    expect(catalogToolSeeder.seedForTenantBestEffort).toHaveBeenCalledWith(
      'tenant-1',
    );
  });

  // F26 (D4/D10): the same guarantee for track_order. Migration 0060
  // backfills every tenant that already existed; this is what stops a
  // freshly provisioned one from being the one the tool is unreachable for.
  it('enables the track_order agent tool for the new tenant', async () => {
    const { service, persistence, courierToolSeeder } = makeHarness();
    persistence.runAdminQuery.mockResolvedValue([
      { id: 'tenant-1', name: 'Acme' },
    ]);

    await service.signUp('user-1', 'Acme');

    expect(courierToolSeeder.seedForTenantBestEffort).toHaveBeenCalledWith(
      'tenant-1',
    );
  });

  // A JWT is a snapshot. Someone who signed up minutes ago still holds the
  // token they had beforehand, which says they have no tenant — replaying
  // signup with it used to mint a second workspace and repoint their claims
  // at it, stranding the first one and its data with no way back in.
  it('refuses a replayed signup from a token minted before the claims were written', async () => {
    const { service, persistence, provisioning } = makeHarness();
    provisioning.findAssignedTenantId.mockResolvedValue('tenant-1');

    await expect(service.signUp('user-1', 'Second Workspace')).rejects.toThrow(
      /already belongs to a tenant/,
    );
    expect(persistence.runAdminQuery).not.toHaveBeenCalled();
    expect(provisioning.assignTenantClaims).not.toHaveBeenCalled();
  });

  // The tenant row is committed before the claims are written. A failure
  // there would otherwise leave a workspace nobody can reach — and the
  // caller, seeing a 500, would strand another one on every retry.
  it('deletes the tenant it just created when claim assignment fails', async () => {
    const { service, persistence, provisioning } = makeHarness();
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          insert: () => ({
            values: () => ({
              returning: () =>
                Promise.resolve([{ id: 'tenant-1', name: 'Acme' }]),
            }),
          }),
          delete: () => ({ where: deleteWhere }),
        }),
    );
    provisioning.assignTenantClaims.mockRejectedValue(
      new Error('auth provider unreachable'),
    );

    await expect(service.signUp('user-1', 'Acme')).rejects.toThrow(
      'auth provider unreachable',
    );
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('reports claimsAssigned true when the real Supabase provider is configured', async () => {
    const { service, persistence } = makeHarness({
      tenantProvisioningProvider: 'supabase',
    });
    persistence.runAdminQuery.mockResolvedValue([
      { id: 'tenant-1', name: 'Acme' },
    ]);

    const result = await service.signUp('user-1', 'Acme');

    expect(result.claimsAssigned).toBe(true);
  });

  it('starts a local trial row for the new tenant after claims are assigned', async () => {
    const { service, persistence, billing } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          insert: () => ({
            values: () => ({
              returning: () =>
                Promise.resolve([{ id: 'tenant-1', name: 'Acme' }]),
            }),
          }),
        }),
    );

    await service.signUp('user-1', 'Acme');

    expect(billing.startLocalTrial).toHaveBeenCalledWith('tenant-1');
  });

  // The tenant and its claims are already fully committed once this runs —
  // a trial-row failure must not undo (or fail to report as successful) a
  // workspace the user can already sign into.
  it('still returns a successful signup when starting the local trial fails', async () => {
    const { service, persistence, billing } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          insert: () => ({
            values: () => ({
              returning: () =>
                Promise.resolve([{ id: 'tenant-1', name: 'Acme' }]),
            }),
          }),
        }),
    );
    billing.startLocalTrial.mockRejectedValue(new Error('db unavailable'));

    await expect(service.signUp('user-1', 'Acme')).resolves.toMatchObject({
      tenantId: 'tenant-1',
    });
  });

  it('rejects signup for a user who already has a tenant (no duplicate tenant, no claim overwrite)', async () => {
    const { service, persistence, provisioning } = makeHarness();

    await expect(
      service.signUp('user-1', 'Acme', 'existing-tenant'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(persistence.runAdminQuery).not.toHaveBeenCalled();
    expect(provisioning.assignTenantClaims).not.toHaveBeenCalled();
  });
});
