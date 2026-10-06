// Closing, reopening, and inspecting a workspace's closure.
//
// Shares the `onboarding/tenant` path with OnboardingModule's TenantController
// (which owns the GET). Deliberately a separate controller in a separate
// module rather than more methods on that one: offboarding needs billing,
// storage, and the retrieval partition service, and pulling all of that into
// OnboardingModule — which BillingModule and others already sit near — is how
// import cycles start. Nest routes by method, so the split costs nothing at
// runtime.
import { Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiAdminOnlyResponses } from '../../common/api-error.dto';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  TenantClosureDto,
  type TenantClosureRecord,
} from './tenant-lifecycle.dto';
import { TenantLifecycleService } from './tenant-lifecycle.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('onboarding/tenant')
@UseGuards(RolesGuard)
@Roles('admin')
export class TenantLifecycleController {
  constructor(private readonly lifecycle: TenantLifecycleService) {}

  @Delete()
  @ApiOperation({
    summary: 'Close the workspace',
    description:
      "Closes the calling tenant's workspace. **Access stops immediately** — every other endpoint starts returning 403 for every member within seconds.\n\nNothing is deleted yet. `purgeAfter` in the response is when the data is actually erased, and until then `POST /onboarding/tenant/reopen` undoes this completely. That window exists because the erasure is unrecoverable and this endpoint is exactly what a compromised admin session would be used against.\n\nWhen the grace period expires a scheduled sweep erases everything: all conversations, tickets, customers, knowledge-base documents and their stored files, message attachments, the vector index partition, the audit log, and the workspace itself. The Stripe subscription is cancelled at the same time. None of it is recoverable.\n\n409 if the workspace is already closed.",
  })
  @ApiOkResponse({ type: TenantClosureDto })
  @ApiConflictResponse({ description: 'This workspace is already closed.' })
  async close(
    @CurrentAuth() auth: TenantAuthContext,
    @Audit() audit: AuditDetail,
  ): Promise<TenantClosureRecord> {
    const closure = await this.lifecycle.close(auth.tenantId);
    audit.describe('workspace.closed', {
      purgeAfter: closure.purgeAfter?.toISOString() ?? 'unknown',
    });
    return closure;
  }

  @Post('reopen')
  @ApiOperation({
    summary: 'Reopen a closed workspace',
    description:
      'Cancels a scheduled closure and restores access. Works only while the grace period is still running — once the purge sweep has erased the workspace there is nothing left to reopen, and the call 404s.\n\nThis is one of only two endpoints a closed workspace can still reach; everything else 403s until it is reopened.\n\n409 if the workspace is not closed.',
  })
  @ApiCreatedResponse({ type: TenantClosureDto })
  @ApiConflictResponse({ description: 'This workspace is not closed.' })
  async reopen(
    @CurrentAuth() auth: TenantAuthContext,
    @Audit() audit: AuditDetail,
  ): Promise<TenantClosureRecord> {
    const closure = await this.lifecycle.reopen(auth.tenantId);
    audit.describe('workspace.reopened', {});
    return closure;
  }

  @Get('closure')
  @ApiOperation({
    summary: 'Check closure status',
    description:
      'Whether this workspace is closed and, if so, when its data is erased. Both fields are null for an open workspace.\n\nReachable while closed, so an admin can always see the deadline they are working against.',
  })
  @ApiOkResponse({ type: TenantClosureDto })
  async closure(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<TenantClosureRecord | null> {
    return this.lifecycle.getClosure(auth.tenantId);
  }
}
