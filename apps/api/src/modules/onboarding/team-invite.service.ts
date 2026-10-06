// OnboardingModule (Feature 6): "Team invite / user provisioning: admin
// invites agents, assigns the Admin/Agent role claim (required by T14,
// not new schema but a UI+endpoint gap T14 alone doesn't cover)." No new
// local schema — same reasoning tickets.table.ts's `assigneeId` already
// documents (the invited user's real record lives in Supabase's own
// `auth.users`, not this app's Postgres) — this service is a thin wrapper
// over `TenantAuthProvisioningPort.inviteTeamMember()`, scoping every
// invite to the calling admin's own tenant (never a client-supplied one).
import { Injectable } from '@nestjs/common';
import type { AppRole } from '../auth/jwt-claims';
import { TenantAuthProvisioningPort } from './ports/tenant-auth-provisioning.port';
import type { TeamInviteResult } from './team-invite.dto';

@Injectable()
export class TeamInviteService {
  constructor(private readonly provisioning: TenantAuthProvisioningPort) {}

  async inviteMember(
    tenantId: string,
    email: string,
    appRole: AppRole,
  ): Promise<TeamInviteResult> {
    const { userId, invited } = await this.provisioning.inviteTeamMember(
      email,
      tenantId,
      appRole,
    );
    return { userId, email, appRole, invited };
  }
}
