// Product shell (AgentConfigModule, F9): the admin-only surface a tenant
// creates and configures agents through.
//
// Admin-gated, like every other tenant-configuration surface (T14): agent
// configuration decides what the business says to its own customers, which
// is a different authority from handling a ticket. Support agents read and
// work tickets; they do not rewrite the agent's policy.
//
// There is deliberately no field here for a system prompt. F9 Decision 1:
// the platform instruction set (L0) carries the injection defense, the
// citation contract and the always-on escalations, and is not tenant-
// editable at any price. Everything below is structured configuration the
// platform renders into L1/L2.
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ApiAdminOnlyResponses,
  ApiErrorDto,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  createAgentBodySchema,
  sandboxBodySchema,
  setKnowledgeScopeBodySchema,
  updateAgentBodySchema,
  AgentListDto,
  AgentRecordDto,
  AgentVersionListDto,
  KnowledgeScopeDto,
  SandboxBodyDto,
  SetKnowledgeScopeBodyDto,
  SandboxResultDto,
  WhatsappNumberListDto,
  CreateAgentBodyDto,
  UpdateAgentBodyDto,
  type AgentRecord,
  type AgentVersionSummary,
  type WhatsappNumberOption,
} from './agent-config.dto.zod';
import { AgentManagementService } from './agent-management.service';
import {
  AgentSandboxService,
  type SandboxTurnResult,
} from './agent-sandbox.service';

const AGENT_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description: 'Agent id. A non-UUID value is rejected with 400.',
} as const;

const NOT_FOUND = {
  status: 404,
  description: 'No such agent in the calling tenant.',
  type: ApiErrorDto,
} as const;

@ApiTags('agents')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('agents')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class AgentsController {
  constructor(
    private readonly agentManagement: AgentManagementService,
    private readonly sandbox: AgentSandboxService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List agents',
    description:
      "Every agent in the calling tenant, newest first. `config` is the DRAFT when one exists, otherwise the published version — a screen showing published values while a draft exists would hide the tenant's own unsaved edits from them.",
  })
  @ApiOkResponse({ type: AgentListDto })
  list(@CurrentAuth() auth: TenantAuthContext): Promise<AgentRecord[]> {
    return this.agentManagement.list(auth.tenantId);
  }

  /** Declared before `:id` — Nest matches in declaration order, and the param route would otherwise swallow this. */
  @Get('numbers')
  @ApiOperation({
    summary: 'WhatsApp numbers available to bind',
    description:
      'Every number connected to this tenant, and which agent currently answers on it. Credentials are never included.',
  })
  @ApiOkResponse({ type: WhatsappNumberListDto })
  numbers(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<WhatsappNumberOption[]> {
    return this.agentManagement.listNumbers(auth.tenantId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create an agent',
    description:
      'Creates a DRAFT agent. It answers nobody until it is published and bound to a WhatsApp number, so creating one can never affect live traffic.',
  })
  @ApiCreatedResponse({ type: AgentRecordDto })
  @ApiValidationErrorResponse()
  create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createAgentBodySchema))
    body: CreateAgentBodyDto,
  ): Promise<AgentRecord> {
    return this.agentManagement.create(
      auth.tenantId,
      auth.userId,
      body.name,
      body.config,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one agent' })
  @ApiParam(AGENT_ID_PARAM)
  @ApiOkResponse({ type: AgentRecordDto })
  @ApiResponse(NOT_FOUND)
  get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRecord> {
    return this.agentManagement.get(auth.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit an agent (writes the draft)',
    description:
      'Edits land on the DRAFT, never on what customers are currently getting — publish is what makes a change live. Omitted fields keep their current value; sending `null` for an optional text field clears it.\n\nAn agent with no draft gets one forked from its published version first, so setting a single field never resets the others.\n\n`whatsappNumberId` is the exception: it applies immediately and is not versioned, because routing is a decision about now — a rollback to an older configuration must not silently move a live number. Binding a number another agent already answers on returns 409 rather than redirecting live traffic.',
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiOkResponse({ type: AgentRecordDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 409,
    description: 'That WhatsApp number already answers as another agent.',
    type: ApiErrorDto,
  })
  @ApiResponse(NOT_FOUND)
  update(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAgentBodySchema))
    body: UpdateAgentBodyDto,
  ): Promise<AgentRecord> {
    return this.agentManagement.update(
      auth.tenantId,
      auth.userId,
      id,
      body.name,
      body.config,
      body.whatsappNumberId,
    );
  }

  @Post(':id/archive')
  @ApiOperation({
    summary: 'Take an agent out of service',
    description:
      'The agent stops answering and its number binding is cleared, so a replacement agent can take that traffic. Its versions and past runs are kept — archiving is not deleting, and old `agent_runs` rows must still resolve to the agent that produced them.',
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiCreatedResponse({ type: AgentRecordDto })
  @ApiResponse(NOT_FOUND)
  archive(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRecord> {
    return this.agentManagement.archive(auth.tenantId, id);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary: 'Publish the draft',
    description:
      'Makes the draft the live configuration and freezes it: a published version is never edited again, which is what makes rollback and per-run attribution (`agent_runs.agent_config_version`) meaningful.\n\nPublishing an agent with no draft is a no-op, not an error — what the tenant sees is already live.',
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiCreatedResponse({ type: AgentRecordDto })
  @ApiResponse(NOT_FOUND)
  publish(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRecord> {
    return this.agentManagement.publish(auth.tenantId, id);
  }

  @Post(':id/sandbox')
  @ApiOperation({
    summary: 'Ask this agent a question without involving a customer',
    description:
      "Runs a real turn — same retrieval, same grounding and escalation checks — against the agent's DRAFT configuration when it has one, so you can test an edit before publishing it.\n\nNothing is sent to WhatsApp and nothing is recorded: no conversation, no ticket, and deliberately no `agent_runs` row, so testing a draft twenty times cannot move the resolution rate and escalation mix your workspace is judged on.",
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiCreatedResponse({ type: SandboxResultDto })
  @ApiValidationErrorResponse()
  @ApiResponse(NOT_FOUND)
  runSandbox(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(sandboxBodySchema)) body: SandboxBodyDto,
  ): Promise<SandboxTurnResult> {
    return this.sandbox.run(auth.tenantId, id, body.message);
  }

  @Get(':id/knowledge')
  @ApiOperation({
    summary: 'Which knowledge-base documents this agent may use',
    description:
      'Every document in the workspace, flagged with whether this agent is scoped to it. `scopedToAll` is true when nothing is selected, which means the agent may use everything — an agent scoped to zero documents could answer nothing, which is never what anyone means.',
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiOkResponse({ type: KnowledgeScopeDto })
  @ApiResponse(NOT_FOUND)
  knowledge(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.agentManagement.knowledgeScope(auth.tenantId, id);
  }

  @Put(':id/knowledge')
  @ApiOperation({
    summary: "Set this agent's document scope",
    description:
      'Replaces the scope wholesale. An **empty** `documentIds` means the whole knowledge base, not none.\n\nApplies immediately and is not versioned: which documents an agent may read is a live access decision, and a configuration rollback must not silently change it.',
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiOkResponse({ type: KnowledgeScopeDto })
  @ApiValidationErrorResponse()
  @ApiResponse(NOT_FOUND)
  async setKnowledge(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setKnowledgeScopeBodySchema))
    body: SetKnowledgeScopeBodyDto,
  ) {
    await this.agentManagement.setKnowledgeScope(
      auth.tenantId,
      id,
      body.documentIds,
    );
    return this.agentManagement.knowledgeScope(auth.tenantId, id);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'Version history',
    description:
      'Every version of this agent, newest first, each with the full configuration it froze. This is what a rollback picks from and what a diff between two versions is computed against.',
  })
  @ApiParam(AGENT_ID_PARAM)
  @ApiOkResponse({ type: AgentVersionListDto })
  @ApiResponse(NOT_FOUND)
  versions(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentVersionSummary[]> {
    return this.agentManagement.versions(auth.tenantId, id);
  }
}
