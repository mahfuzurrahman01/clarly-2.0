// Product shell (OnboardingModule, F15): the rest of "admin manages team"
// (T14) — reading the roster, changing a role, removing a member. Sits
// beside TeamInviteController rather than inside it because that
// controller is mounted on the narrower `onboarding/team/invite` path.
//
// Admin-only throughout, including the read: the picker version of this
// list is already available to agents at `GET /kanban/tickets/team`, and
// this one exists to back a settings screen only an admin can act on.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  changeTeamRoleBodySchema,
  ChangeTeamRoleBodyDto,
  RemoveTeamMemberResultDto,
  TeamMemberDto,
  TeamMemberListDto,
  type RemoveTeamMemberResult,
  type TeamMemberRecord,
} from './team.dto';
import { TeamService } from './team.service';

const MEMBER_ID_PARAM = {
  name: 'userId',
  description: 'Supabase Auth user id of the member being acted on.',
} as const;

@ApiTags('onboarding')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('onboarding/team')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @ApiOperation({
    summary: 'List workspace members',
    description:
      'Everyone whose claims put them in the calling tenant, with their role.\n\nComes from the auth provider, since users do not live in this database. An empty list means the provider cannot answer — under `TENANT_PROVISIONING_PROVIDER=none` there is no directory at all, and member management is unavailable rather than empty.',
  })
  @ApiOkResponse({ type: TeamMemberListDto })
  list(@CurrentAuth() auth: TenantAuthContext): Promise<TeamMemberRecord[]> {
    return this.team.listMembers(auth.tenantId);
  }

  @Patch(':userId')
  @ApiOperation({
    summary: "Change a member's role",
    description:
      'Refused in two cases, both of which would lock a workspace out of its own settings: changing your **own** role (400), and demoting the **only** admin (409).',
  })
  @ApiParam(MEMBER_ID_PARAM)
  @ApiOkResponse({ type: TeamMemberDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 404,
    description: 'No such member in the calling tenant.',
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Would leave the workspace with no admin.',
    type: ApiErrorDto,
  })
  async changeRole(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(changeTeamRoleBodySchema))
    body: ChangeTeamRoleBodyDto,
    @Audit() audit: AuditDetail,
  ): Promise<TeamMemberRecord> {
    const member = await this.team.changeRole(
      auth.tenantId,
      auth.userId,
      userId,
      body.appRole,
    );
    // Naming the person and the new role: a privilege change is the first
    // thing a security review looks for, and a uuid does not answer it.
    audit.describe('team.role_changed', {
      email: member.email,
      role: member.appRole,
    });
    return member;
  }

  @Delete(':userId')
  @ApiOperation({
    summary: 'Remove a member from the workspace',
    description:
      'Clears the member’s tenant claims and puts every unresolved ticket they held back in the OPEN queue — the response says how many.\n\nThe auth identity itself is not deleted; the person simply no longer belongs to this workspace. Because the removal is a claims change, an already-issued token stops working when it next refreshes, not instantly.\n\nRefused when removing yourself (400) or the only admin (409).',
  })
  @ApiParam(MEMBER_ID_PARAM)
  @ApiOkResponse({ type: RemoveTeamMemberResultDto })
  @ApiResponse({
    status: 404,
    description: 'No such member in the calling tenant.',
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Would leave the workspace with no admin.',
    type: ApiErrorDto,
  })
  async remove(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('userId') userId: string,
    @Audit() audit: AuditDetail,
  ): Promise<RemoveTeamMemberResult> {
    const result = await this.team.removeMember(
      auth.tenantId,
      auth.userId,
      userId,
    );
    // The released-ticket count belongs in the trail too: it explains why
    // someone else's queue changed at the same moment.
    audit.describe('team.member_removed', {
      userId,
      releasedTickets: result.releasedTickets,
    });
    return result;
  }
}
