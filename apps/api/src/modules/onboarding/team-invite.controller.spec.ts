import type { TenantAuthContext } from '../auth/jwt-claims';
import { TeamInviteController } from './team-invite.controller';
import type { TeamInviteResult } from './team-invite.dto';
import type { TeamInviteService } from './team-invite.service';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

describe('TeamInviteController', () => {
  it("invites into the caller's own tenant, never a client-supplied one", async () => {
    const teamInvite = { inviteMember: jest.fn() };
    const controller = new TeamInviteController(
      teamInvite as unknown as TeamInviteService,
    );
    const result: TeamInviteResult = {
      userId: 'user-2',
      email: 'agent@example.com',
      appRole: 'agent',
      invited: false,
    };
    teamInvite.inviteMember.mockResolvedValue(result);

    await expect(
      controller.invite(AUTH, { email: 'agent@example.com', appRole: 'agent' }),
    ).resolves.toBe(result);
    expect(teamInvite.inviteMember).toHaveBeenCalledWith(
      'tenant-a',
      'agent@example.com',
      'agent',
    );
  });
});
