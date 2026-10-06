// Product shell (OnboardingModule, F15): managing an existing team, as
// opposed to TeamInviteService which only adds to it. T14's line — "admin
// manages team, tenant config, and policy" — was half-built: a workspace
// could grow but never shrink, and a role assigned at invite time was
// permanent.
//
// Members live in Supabase Auth, not in this database, so
// TenantAuthProvisioningPort is the only directory there is. Every
// operation here therefore starts by reading that directory to prove the
// target is in the caller's tenant; there is no local row to scope with
// RLS.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppLoggerService } from '../core';
import type { AppRole } from '../auth/jwt-claims';
import { TicketStateService } from '../ticket/ticket-state.service';
import {
  TenantAuthProvisioningPort,
  type TeamMember,
} from './ports/tenant-auth-provisioning.port';

@Injectable()
export class TeamService {
  constructor(
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly ticketState: TicketStateService,
    private readonly logger: AppLoggerService,
  ) {}

  listMembers(tenantId: string): Promise<TeamMember[]> {
    return this.provisioning.listTeamMembers(tenantId);
  }

  /**
   * Changing a role is the same Admin API write as assigning one at invite
   * time; the guards are what make it a different operation.
   *
   * An admin cannot change their own role. Self-demotion is the fastest way
   * to lock a workspace out of its own settings, and it reads as an
   * accident far more often than an intent — the honest fix is another
   * admin doing it.
   */
  async changeRole(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
    appRole: AppRole,
  ): Promise<TeamMember> {
    const members = await this.listMembers(tenantId);
    const target = this.requireMember(members, targetUserId);

    if (targetUserId === actorUserId) {
      throw new BadRequestException(
        'You cannot change your own role — ask another admin.',
      );
    }
    if (target.appRole === appRole) {
      return target;
    }
    if (appRole !== 'admin') {
      this.requireAnotherAdminRemains(members, targetUserId);
    }

    await this.provisioning.assignTenantClaims(targetUserId, tenantId, appRole);

    return { ...target, appRole };
  }

  /**
   * Removal is claim revocation plus one piece of cleanup: the person's
   * unresolved tickets go back in the queue. Without that, work sits
   * assigned to someone who can no longer sign in — invisible to the board
   * and permanently "stuck".
   *
   * Order: release the tickets first. If claim revocation then fails, the
   * tenant has tickets back in a queue anyone can pick up, which is
   * recoverable. The reverse order can strand tickets under a user the
   * admin can no longer see in order to reassign them.
   */
  async removeMember(
    tenantId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ releasedTickets: number }> {
    const members = await this.listMembers(tenantId);
    this.requireMember(members, targetUserId);

    if (targetUserId === actorUserId) {
      throw new BadRequestException(
        'You cannot remove yourself from the workspace.',
      );
    }
    this.requireAnotherAdminRemains(members, targetUserId);

    const releasedTickets = await this.ticketState.releaseAssignmentsFor(
      tenantId,
      targetUserId,
    );

    await this.provisioning.revokeTenantClaims(targetUserId);

    this.logger.log(
      `Removed user ${targetUserId} from tenant ${tenantId}; released ${releasedTickets} ticket(s) back to the queue`,
      'TeamService',
    );

    return { releasedTickets };
  }

  /** 404 rather than 403 for a user in another tenant, matching how every other tenant-scoped read here treats a foreign id. */
  private requireMember(members: TeamMember[], userId: string): TeamMember {
    const member = members.find((candidate) => candidate.userId === userId);
    if (!member) {
      throw new NotFoundException(
        `No such member in this workspace: ${userId}`,
      );
    }
    return member;
  }

  /**
   * A workspace with no admin can never edit its policy, manage its KB, or
   * invite anyone again — and nothing in the product can repair it without
   * database access. Cheaper to refuse.
   */
  private requireAnotherAdminRemains(
    members: TeamMember[],
    excludedUserId: string,
  ): void {
    const remainingAdmins = members.filter(
      (member) =>
        member.appRole === 'admin' && member.userId !== excludedUserId,
    );
    if (remainingAdmins.length === 0) {
      throw new ConflictException(
        'This is the workspace’s only admin — promote someone else first.',
      );
    }
  }
}
