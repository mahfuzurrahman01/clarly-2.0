import type { TenantAuthContext } from '../auth/jwt-claims';
import { TeamController } from './team.controller';
import type { TeamService } from './team.service';
import { recordingAudit } from '../audit/__fixtures__/recording-audit';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

function makeController() {
  const team = {
    listMembers: jest.fn(),
    changeRole: jest.fn(),
    removeMember: jest.fn(),
  };
  return {
    controller: new TeamController(team as unknown as TeamService),
    team,
  };
}

describe('TeamController', () => {
  it("list() reads the caller's own tenant roster", async () => {
    const { controller, team } = makeController();
    team.listMembers.mockResolvedValue([]);

    await expect(controller.list(AUTH)).resolves.toEqual([]);
    expect(team.listMembers).toHaveBeenCalledWith('tenant-a');
  });

  it('changeRole() passes the caller as the actor, so the service can refuse self-demotion', async () => {
    const { controller, team } = makeController();
    team.changeRole.mockResolvedValue({
      userId: 'agent-1',
      email: 'a@b.test',
      appRole: 'admin',
    });

    await controller.changeRole(
      AUTH,
      'agent-1',
      { appRole: 'admin' },
      { describe: () => {} },
    );

    expect(team.changeRole).toHaveBeenCalledWith(
      'tenant-a',
      'admin-1',
      'agent-1',
      'admin',
    );
  });

  it('remove() passes the caller as the actor and returns the released-ticket count', async () => {
    const { controller, team } = makeController();
    team.removeMember.mockResolvedValue({ releasedTickets: 2 });

    await expect(
      controller.remove(AUTH, 'agent-1', { describe: () => {} }),
    ).resolves.toEqual({
      releasedTickets: 2,
    });
    expect(team.removeMember).toHaveBeenCalledWith(
      'tenant-a',
      'admin-1',
      'agent-1',
    );
  });

  // The interceptor records that this route was called; only the handler knows
  // WHO was changed and to WHAT. A privilege change is the first thing a
  // security review looks for, and a uuid does not answer it.
  it('describes the role change for the audit trail, naming member and new role', async () => {
    const { controller, team } = makeController();
    team.changeRole.mockResolvedValue({
      userId: 'agent-1',
      email: 'agent@acme.test',
      appRole: 'admin',
    });
    const audit = recordingAudit();

    await controller.changeRole(AUTH, 'agent-1', { appRole: 'admin' }, audit);

    expect(audit.described).toEqual([
      "Changed agent@acme.test's role to admin",
    ]);
    expect(audit.recorded[0]).toMatchObject({
      key: 'team.role_changed',
      params: { email: 'agent@acme.test', role: 'admin' },
    });
  });

  it('describes a removal including the released-ticket count', async () => {
    const { controller, team } = makeController();
    team.removeMember.mockResolvedValue({ releasedTickets: 2 });
    const audit = recordingAudit();

    await controller.remove(AUTH, 'agent-1', audit);

    expect(audit.described[0]).toContain('Removed member agent-1');
    expect(audit.described[0]).toContain('2 unresolved ticket(s) released');
    expect(audit.recorded[0]).toMatchObject({
      key: 'team.member_removed',
      params: { userId: 'agent-1', releasedTickets: 2 },
    });
  });
});
