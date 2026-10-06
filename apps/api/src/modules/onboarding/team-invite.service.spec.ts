import type { TenantAuthProvisioningPort } from './ports/tenant-auth-provisioning.port';
import { TeamInviteService } from './team-invite.service';

describe('TeamInviteService.inviteMember()', () => {
  it('scopes the invite to the given tenant and returns the combined result', async () => {
    const provisioning = {
      inviteTeamMember: jest
        .fn()
        .mockResolvedValue({ userId: 'user-2', invited: true }),
    };
    const service = new TeamInviteService(
      provisioning as unknown as TenantAuthProvisioningPort,
    );

    const result = await service.inviteMember(
      'tenant-a',
      'agent@example.com',
      'agent',
    );

    expect(result).toEqual({
      userId: 'user-2',
      email: 'agent@example.com',
      appRole: 'agent',
      invited: true,
    });
    expect(provisioning.inviteTeamMember).toHaveBeenCalledWith(
      'agent@example.com',
      'tenant-a',
      'agent',
    );
  });
});
