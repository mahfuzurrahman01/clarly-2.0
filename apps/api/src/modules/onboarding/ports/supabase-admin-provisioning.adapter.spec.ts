import type { AppConfigService } from '../../core';
import { SupabaseAdminProvisioningAdapter } from './supabase-admin-provisioning.adapter';

const updateUserById = jest.fn();
const inviteUserByEmail = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { admin: { updateUserById, inviteUserByEmail } },
  })),
}));

function makeConfig(): AppConfigService {
  return {
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key',
  } as AppConfigService;
}

describe('SupabaseAdminProvisioningAdapter', () => {
  beforeEach(() => {
    updateUserById.mockReset();
    inviteUserByEmail.mockReset();
  });

  it('does not construct the Supabase client eagerly in the constructor (safe to instantiate even under the noop-selected default)', () => {
    expect(
      () => new SupabaseAdminProvisioningAdapter(makeConfig()),
    ).not.toThrow();
  });

  it('calls the Admin API with app_metadata.tenant_id/app_role on assignTenantClaims', async () => {
    updateUserById.mockResolvedValue({ error: null });
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    await adapter.assignTenantClaims('user-1', 'tenant-1', 'admin');

    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { tenant_id: 'tenant-1', app_role: 'admin' },
    });
  });

  it('nulls both claims on revokeTenantClaims — ending a membership, not deleting the person', async () => {
    updateUserById.mockResolvedValue({ error: null });
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    await adapter.revokeTenantClaims('user-1');

    expect(updateUserById).toHaveBeenCalledWith('user-1', {
      app_metadata: { tenant_id: null, app_role: null },
    });
  });

  it('surfaces an Admin API refusal on revoke rather than reporting a removal that did not happen', async () => {
    updateUserById.mockResolvedValue({ error: { message: 'nope' } });
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    await expect(adapter.revokeTenantClaims('user-1')).rejects.toThrow('nope');
  });

  it('builds the Supabase client only once across multiple calls (lazy-init reuse)', async () => {
    updateUserById.mockResolvedValue({ error: null });
    const { createClient } = jest.requireMock<{ createClient: jest.Mock }>(
      '@supabase/supabase-js',
    );
    createClient.mockClear();
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    await adapter.assignTenantClaims('user-1', 'tenant-1', 'admin');
    await adapter.assignTenantClaims('user-2', 'tenant-1', 'agent');

    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('throws when the Admin API returns an error', async () => {
    updateUserById.mockResolvedValue({ error: { message: 'boom' } });
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    await expect(
      adapter.assignTenantClaims('user-1', 'tenant-1', 'admin'),
    ).rejects.toThrow('boom');
  });

  it('inviteTeamMember() invites by email, then assigns tenant/role claims on the invited user id', async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: { id: 'user-2' } },
      error: null,
    });
    updateUserById.mockResolvedValue({ error: null });
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    const result = await adapter.inviteTeamMember(
      'agent@example.com',
      'tenant-1',
      'agent',
    );

    expect(inviteUserByEmail).toHaveBeenCalledWith('agent@example.com');
    expect(updateUserById).toHaveBeenCalledWith('user-2', {
      app_metadata: { tenant_id: 'tenant-1', app_role: 'agent' },
    });
    expect(result).toEqual({ userId: 'user-2', invited: true });
  });

  it('inviteTeamMember() throws when the invite call itself fails, without attempting to assign claims', async () => {
    inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { message: 'email already registered' },
    });
    const adapter = new SupabaseAdminProvisioningAdapter(makeConfig());

    await expect(
      adapter.inviteTeamMember('agent@example.com', 'tenant-1', 'agent'),
    ).rejects.toThrow('email already registered');
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
