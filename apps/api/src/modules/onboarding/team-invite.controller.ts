// Product shell (OnboardingModule, Feature 6): admin-only — T14's own
// line: "Admin manages team, tenant config, and policy." Unlike
// `SignupController`, this one DOES sit behind the normal
// `TenantAuthMiddleware`/`CurrentAuth()` path: the calling admin already
// has a tenant, and every invite is scoped to that tenant, never a
// client-supplied one.
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ApiAdminOnlyResponses,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { teamInviteBodySchema, TeamInviteBodyDto } from './team-invite.dto.zod';
import { TeamInviteResultDto, type TeamInviteResult } from './team-invite.dto';
import { TeamInviteService } from './team-invite.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('onboarding/team/invite')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class TeamInviteController {
  constructor(private readonly teamInvite: TeamInviteService) {}

  @Post()
  @ApiOperation({
    summary: 'Invite a team member',
    description:
      "Invites an address into the calling admin's tenant — the tenant is always taken from the caller's token, never from the request body. `invited: false` in the response means the member was recorded but the provisioning provider is a no-op, so no email actually went out.",
  })
  @ApiCreatedResponse({ type: TeamInviteResultDto })
  @ApiValidationErrorResponse()
  invite(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(teamInviteBodySchema)) body: TeamInviteBodyDto,
  ): Promise<TeamInviteResult> {
    return this.teamInvite.inviteMember(
      auth.tenantId,
      body.email,
      body.appRole,
    );
  }
}
