// Product shell (OnboardingModule, T14/T15): the admin-only write surface
// over T15's tenant policy row. Pulled forward from its originally
// planned Feature 6 landing spot — the former feature plan's Feature 5 exit
// criteria explicitly requires "admin role can manage team/config, agent
// role cannot" to be PROVEN this feature, not deferred, so this is the
// concrete endpoint that satisfies it (KanbanModule's ticket endpoints,
// Feature 5 Slice 3, are deliberately ungated and don't exercise T14's
// admin/agent split at all). Feature 6 still owns the actual UI this
// wraps, plus tenant signup and KB upload — this controller doesn't
// duplicate or preempt that, it just gives T14's own verify line a real
// endpoint to prove itself against now.
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  ApiBearerAuth,
  ApiOkResponse,
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
import {
  TenantPolicyRecordDto,
  type TenantPolicyRecord,
} from './tenant-policy.dto';
import {
  upsertTenantPolicyBodySchema,
  UpsertTenantPolicyBodyDto,
} from './tenant-policy.dto.zod';
import { AgentManagementService } from '../agent-config/agent-management.service';
import { TenantPolicyService } from './tenant-policy.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('onboarding/tenant-policy')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class TenantPolicyController {
  constructor(
    private readonly tenantPolicy: TenantPolicyService,
    private readonly agentManagement: AgentManagementService,
    private readonly logger: AppLoggerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get tenant policy',
    description:
      "The calling tenant's agent policy — confidence threshold, forbidden topics, persona override, rerank flag, stuck-ticket threshold. Returns `null` (200, empty body) when the tenant has never PATCHed a policy and is running on defaults.",
  })
  @ApiOkResponse({
    type: TenantPolicyRecordDto,
    description: 'The policy row, or `null` when the tenant has none yet.',
  })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<TenantPolicyRecord | null> {
    return this.tenantPolicy.getForTenant(auth.tenantId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update tenant policy (superseded by `PATCH /agents/:id`)',
    description:
      "Partial update — every field is optional and omitted fields keep their current value. Creates the policy row if the tenant does not have one yet. Returns the full row after the write.\n\n**Superseded by the agents API (F9).** The respond path now runs from an agent's published configuration, so this endpoint writes through: it applies these fields to the tenant's single published agent and publishes immediately. Without that, an edit here would return 200 and change nothing a customer ever sees.\n\nA tenant with several agents cannot be edited through this endpoint — there is no single agent to apply it to — and must use `PATCH /agents/:id` + `POST /agents/:id/publish`. The policy row is still written either way, because the stuck-ticket sweep and the board config read it.",
  })
  @ApiOkResponse({ type: TenantPolicyRecordDto })
  @ApiValidationErrorResponse()
  async upsert(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(upsertTenantPolicyBodySchema))
    body: UpsertTenantPolicyBodyDto,
  ): Promise<TenantPolicyRecord> {
    // Agent first: publishing mirrors the same fields back onto the policy
    // row, so doing it in this order leaves one write as the last word
    // instead of two racing for it.
    const appliedToAgent = await this.agentManagement.applyLegacyPolicy(
      auth.tenantId,
      auth.userId,
      body,
    );

    const record = await this.tenantPolicy.upsert(auth.tenantId, body);

    if (!appliedToAgent) {
      this.logger.warn(
        `tenant ${auth.tenantId} updated tenant_policy but has no single published agent — the change affects the stuck-ticket threshold only, not how the agent answers`,
        'TenantPolicyController',
      );
    }

    return record;
  }
}
