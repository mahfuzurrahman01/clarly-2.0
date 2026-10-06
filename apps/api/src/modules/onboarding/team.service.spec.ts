import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AppLoggerService } from '../core';
import type { TicketStateService } from '../ticket/ticket-state.service';
import type {
  TeamMember,
  TenantAuthProvisioningPort,
} from './ports/tenant-auth-provisioning.port';
import { TeamService } from './team.service';

const TENANT = 'tenant-a';
const ADMIN = 'admin-1';
const OTHER_ADMIN = 'admin-2';
const AGENT = 'agent-1';

function members(...overrides: TeamMember[]): TeamMember[] {
  return overrides;
}

const adminMember: TeamMember = {
  userId: ADMIN,
  email: 'admin@acme.test',
  appRole: 'admin',
};
const otherAdminMember: TeamMember = {
  userId: OTHER_ADMIN,
  email: 'second@acme.test',
  appRole: 'admin',
};
const agentMember: TeamMember = {
  userId: AGENT,
  email: 'agent@acme.test',
  appRole: 'agent',
};

function makeService(roster: TeamMember[]) {
  const listTeamMembers = jest.fn().mockResolvedValue(roster);
  const assignTenantClaims = jest.fn().mockResolvedValue(undefined);
  const revokeTenantClaims = jest.fn().mockResolvedValue(undefined);
  const releaseAssignmentsFor = jest.fn().mockResolvedValue(0);
  const service = new TeamService(
    {
      listTeamMembers,
      assignTenantClaims,
      revokeTenantClaims,
    } as unknown as TenantAuthProvisioningPort,
    { releaseAssignmentsFor } as unknown as TicketStateService,
    { log: jest.fn(), warn: jest.fn() } as unknown as AppLoggerService,
  );
  return {
    service,
    listTeamMembers,
    assignTenantClaims,
    revokeTenantClaims,
    releaseAssignmentsFor,
  };
}

describe('TeamService.changeRole()', () => {
  it('writes the new role through the auth provider', async () => {
    const { service, assignTenantClaims } = makeService(
      members(adminMember, agentMember),
    );

    await expect(
      service.changeRole(TENANT, ADMIN, AGENT, 'admin'),
    ).resolves.toMatchObject({ userId: AGENT, appRole: 'admin' });
    expect(assignTenantClaims).toHaveBeenCalledWith(AGENT, TENANT, 'admin');
  });

  it('refuses self-demotion, which is how an admin locks themselves out of their own settings', async () => {
    const { service, assignTenantClaims } = makeService(
      members(adminMember, otherAdminMember),
    );

    await expect(
      service.changeRole(TENANT, ADMIN, ADMIN, 'agent'),
    ).rejects.toThrow(BadRequestException);
    expect(assignTenantClaims).not.toHaveBeenCalled();
  });

  it('refuses to demote the only admin, which would leave the workspace unadministrable', async () => {
    const { service } = makeService(
      members(adminMember, otherAdminMember, agentMember),
    );

    // OTHER_ADMIN is the target; ADMIN is the actor and also an admin, so
    // this one is allowed — the refusal case is the roster below.
    await expect(
      service.changeRole(TENANT, ADMIN, OTHER_ADMIN, 'agent'),
    ).resolves.toMatchObject({ appRole: 'agent' });

    const onlyAdmin = makeService(members(otherAdminMember, agentMember));
    await expect(
      onlyAdmin.service.changeRole(TENANT, AGENT, OTHER_ADMIN, 'agent'),
    ).rejects.toThrow(ConflictException);
  });

  it('404s for a user outside the tenant rather than reporting whether they exist elsewhere', async () => {
    const { service } = makeService(members(adminMember));

    await expect(
      service.changeRole(TENANT, ADMIN, 'stranger', 'agent'),
    ).rejects.toThrow(NotFoundException);
  });

  it('is a no-op when the member already holds the role', async () => {
    const { service, assignTenantClaims } = makeService(
      members(adminMember, agentMember),
    );

    await expect(
      service.changeRole(TENANT, ADMIN, AGENT, 'agent'),
    ).resolves.toMatchObject({ appRole: 'agent' });
    expect(assignTenantClaims).not.toHaveBeenCalled();
  });
});

describe('TeamService.removeMember()', () => {
  it('releases the member’s unresolved tickets so their work does not sit with someone who cannot sign in', async () => {
    const { service, releaseAssignmentsFor } = makeService(
      members(adminMember, agentMember),
    );
    releaseAssignmentsFor.mockResolvedValue(3);

    await expect(service.removeMember(TENANT, ADMIN, AGENT)).resolves.toEqual({
      releasedTickets: 3,
    });
    expect(releaseAssignmentsFor).toHaveBeenCalledWith(TENANT, AGENT);
  });

  it('revokes the tenant claims, which is what actually ends the membership', async () => {
    const { service, revokeTenantClaims } = makeService(
      members(adminMember, agentMember),
    );

    await service.removeMember(TENANT, ADMIN, AGENT);

    expect(revokeTenantClaims).toHaveBeenCalledWith(AGENT);
  });

  it('releases tickets before revoking claims, so a failed revoke cannot strand work under an invisible user', async () => {
    const { service, releaseAssignmentsFor, revokeTenantClaims } = makeService(
      members(adminMember, agentMember),
    );
    const order: string[] = [];
    releaseAssignmentsFor.mockImplementation(() => {
      order.push('release');
      return Promise.resolve(1);
    });
    revokeTenantClaims.mockImplementation(() => {
      order.push('revoke');
      return Promise.resolve(undefined);
    });

    await service.removeMember(TENANT, ADMIN, AGENT);

    expect(order).toEqual(['release', 'revoke']);
  });

  it('refuses self-removal', async () => {
    const { service, revokeTenantClaims } = makeService(
      members(adminMember, otherAdminMember),
    );

    await expect(service.removeMember(TENANT, ADMIN, ADMIN)).rejects.toThrow(
      BadRequestException,
    );
    expect(revokeTenantClaims).not.toHaveBeenCalled();
  });

  it('refuses to remove the last admin, which no in-product action could repair', async () => {
    const { service, revokeTenantClaims, releaseAssignmentsFor } = makeService(
      members(adminMember, agentMember),
    );

    await expect(service.removeMember(TENANT, AGENT, ADMIN)).rejects.toThrow(
      ConflictException,
    );
    expect(revokeTenantClaims).not.toHaveBeenCalled();
    expect(releaseAssignmentsFor).not.toHaveBeenCalled();
  });

  it('404s for a user outside the tenant, and touches nothing', async () => {
    const { service, revokeTenantClaims, releaseAssignmentsFor } = makeService(
      members(adminMember),
    );

    await expect(
      service.removeMember(TENANT, ADMIN, 'stranger'),
    ).rejects.toThrow(NotFoundException);
    expect(revokeTenantClaims).not.toHaveBeenCalled();
    expect(releaseAssignmentsFor).not.toHaveBeenCalled();
  });
});
