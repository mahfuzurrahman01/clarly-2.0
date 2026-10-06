import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  TenantDirectoryEntryDto,
  updateTenantProfileBodySchema,
  type TenantDirectoryEntry,
  type UpdateTenantProfileBody,
} from './tenant-directory.dto';
import { TenantDirectoryService } from './tenant-directory.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@Controller('onboarding/tenant')
export class TenantController {
  constructor(private readonly tenantDirectory: TenantDirectoryService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the calling tenant',
    description:
      "The signed-in user's own workspace — `{ id, name, vertical, country, currency, defaultLocale }` — for rendering workspace identity and defaults in the console. Takes no parameters: the tenant is read from the bearer token's `app_metadata.tenant_id` and there is no way to ask for a different one.\n\nCallable by **both** the `admin` and `agent` roles, unlike the rest of `/onboarding/*`. Returns 404 only when the token carries a tenant id whose row no longer exists, which means a stale session rather than a server fault.",
  })
  @ApiOkResponse({ type: TenantDirectoryEntryDto })
  @ApiNotFoundResponse({
    description:
      'The token’s tenant no longer exists. Sign out and back in; do not retry.',
  })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<TenantDirectoryEntry> {
    const tenant = await this.tenantDirectory.getById(auth.tenantId);
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  @Patch('profile')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiAdminOnlyResponses()
  @ApiOperation({
    summary: 'Update the workspace profile',
    description:
      'v2 S1. Partial update of the workspace name, vertical (`commerce` / `services` / `hybrid`), country (ISO 3166-1 alpha-2), currency (ISO 4217) and default console language. `country` and `currency` accept `null` to clear. Admin only. Not gated by the subscription: an expired workspace must still be able to correct its own details.',
  })
  @ApiOkResponse({ type: TenantDirectoryEntryDto })
  @ApiValidationErrorResponse()
  async updateProfile(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(updateTenantProfileBodySchema))
    body: UpdateTenantProfileBody,
    @Audit() audit: AuditDetail,
  ): Promise<TenantDirectoryEntry> {
    const tenant = await this.tenantDirectory.updateProfile(
      auth.tenantId,
      body,
    );
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    audit.describe('workspace.profile_updated', {
      fields: Object.keys(body).sort().join(', '),
    });
    return tenant;
  }
}
