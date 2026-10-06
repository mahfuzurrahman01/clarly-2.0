import type { AppLoggerService } from '../../core';
import { NoopProvisioningAdapter } from './noop-provisioning.adapter';

describe('NoopProvisioningAdapter', () => {
  it('logs what it would have done instead of throwing or silently succeeding without a trace', async () => {
    const warn = jest.fn();
    const adapter = new NoopProvisioningAdapter({
      warn,
    } as unknown as AppLoggerService);

    await adapter.assignTenantClaims('user-1', 'tenant-1', 'admin');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('tenant-1'),
      'NoopProvisioningAdapter',
    );
  });

  it('inviteTeamMember() fabricates a userId, reports invited: false, and logs what it would have done', async () => {
    const warn = jest.fn();
    const adapter = new NoopProvisioningAdapter({
      warn,
    } as unknown as AppLoggerService);

    const result = await adapter.inviteTeamMember(
      'agent@example.com',
      'tenant-1',
      'agent',
    );

    expect(result.invited).toBe(false);
    expect(result.userId).toEqual(expect.any(String));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('agent@example.com'),
      'NoopProvisioningAdapter',
    );
  });
});
