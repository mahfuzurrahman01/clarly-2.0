// Clarly 2.0 S1: the operator console API (`/platform/*`).
//
// Guarded by PlatformAdminGuard on the class, NOT by TenantAuthMiddleware:
// these routes are not tenant-scoped and an operator's token may carry no
// tenant at all. Reads are open to every operator role; every write added in
// later stages must carry @PlatformRoles(...).
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentPlatformAuth } from './current-platform-auth.decorator';
import type { PlatformAuthContext } from './platform-auth';
import { PlatformAdminGuard } from './platform-admin.guard';
import {
  listPlatformTenantsQuerySchema,
  PlatformMeDto,
  PlatformTenantPageDto,
  PlatformTenantSummaryDto,
  type ListPlatformTenantsQuery,
} from './platform.dto';
import {
  PlatformTenantsService,
  type PlatformTenantPage,
  type PlatformTenantSummary,
} from './platform-tenants.service';

@ApiTags('platform')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@ApiForbiddenResponse()
@UseGuards(PlatformAdminGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Who am I, as an operator',
    description:
      'The calling operator and their platform role. The console calls this first: a 403 means the signed-in user is not an operator and the console must not render `/platform`.',
  })
  @ApiOkResponse({ type: PlatformMeDto })
  me(@CurrentPlatformAuth() auth: PlatformAuthContext): PlatformAuthContext {
    return auth;
  }

  @Get('tenants')
  @ApiOperation({
    summary: 'List workspaces',
    description:
      'Newest first, keyset-paged. Each row carries the workspace profile, its subscription (plan, status, comp flag) and the trailing-30-day agent turns and AI cost. Per-tenant figures are read through each tenant’s own RLS scope, one tenant at a time.',
  })
  @ApiOkResponse({ type: PlatformTenantPageDto })
  list(
    @Query(new ZodValidationPipe(listPlatformTenantsQuerySchema))
    query: ListPlatformTenantsQuery,
  ): Promise<PlatformTenantPage> {
    return this.tenants.list(query);
  }

  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'One workspace' })
  @ApiOkResponse({ type: PlatformTenantSummaryDto })
  async get(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<PlatformTenantSummary> {
    const tenant = await this.tenants.get(tenantId);
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
  }
}
