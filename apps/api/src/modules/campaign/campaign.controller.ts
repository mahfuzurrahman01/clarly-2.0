// F19 (D8): the campaign surface — authoring, the lifecycle verbs, and the
// two read endpoints the console's campaign screen lives on.
//
// Route ordering matters here and is deliberate: every STATIC segment is
// declared before the `:id` routes, because F20 shipped a `@Get('export')`
// that `@Get(':id')` shadowed and 500'd on. Nest matches in declaration
// order, so `/campaigns/:id/stats` must be declared before nothing more
// specific can swallow it — the nested paths below are all under `:id`, so
// each is distinct by its suffix.
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { CampaignStatsService } from './campaign-stats.service';
import { CampaignService } from './campaign.service';
import {
  createCampaignBodySchema,
  listCampaignRecipientsQuerySchema,
  listCampaignsQuerySchema,
  scheduleCampaignBodySchema,
  updateCampaignBodySchema,
  type CreateCampaignBody,
  type ListCampaignRecipientsQuery,
  type ListCampaignsQuery,
  type ScheduleCampaignBody,
  type UpdateCampaignBody,
} from './campaign.dto.zod';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(EntitlementGuard)
@Controller('campaigns')
export class CampaignController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly stats: CampaignStatsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a draft campaign' })
  async create(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(createCampaignBodySchema))
    body: CreateCampaignBody,
    @Audit() audit: AuditDetail,
  ) {
    const campaign = await this.campaigns.create(auth.tenantId, {
      name: body.name,
      segmentId: body.segmentId,
      templateId: body.templateId,
      templateValues: body.templateValues,
      phoneNumberId: body.phoneNumberId,
      spendCapUsd: body.spendCapUsd,
      createdBy: auth.userId,
    });
    audit.describe('campaign.created', { campaignName: body.name });
    return campaign;
  }

  @Get()
  @ApiOperation({ summary: 'List campaigns' })
  async list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listCampaignsQuerySchema))
    query: ListCampaignsQuery,
  ) {
    return this.campaigns.list(auth.tenantId, {
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign by id' })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.campaigns.require(auth.tenantId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edit a draft campaign' })
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCampaignBodySchema))
    body: UpdateCampaignBody,
    @Audit() audit: AuditDetail,
  ) {
    const campaign = await this.campaigns.update(auth.tenantId, id, body);
    audit.describe('campaign.edited', { campaignName: campaign.name });
    return campaign;
  }

  /**
   * Everything refusable happens here — the template gate, the live segment
   * preview, the cost estimate against the cap, and D4's eligibility check.
   * A 422 carries the full reason (the block list, or the three spend
   * numbers) so the merchant can fix it in one trip.
   */
  @Post(':id/schedule')
  @ApiOperation({ summary: 'Schedule a campaign (or send it now)' })
  async schedule(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(scheduleCampaignBodySchema))
    body: ScheduleCampaignBody,
    @Audit() audit: AuditDetail,
  ) {
    const campaign = await this.campaigns.schedule(
      auth.tenantId,
      id,
      body.sendAt ?? null,
    );
    if (campaign.scheduledAt) {
      audit.describe('campaign.scheduled', {
        campaignName: campaign.name,
        scheduledAt: campaign.scheduledAt.toISOString(),
        recipientCount: campaign.recipientCount,
      });
    } else {
      audit.describe('campaign.scheduled_immediate', {
        campaignName: campaign.name,
        recipientCount: campaign.recipientCount,
      });
    }
    return campaign;
  }

  @Post(':id/pause')
  @ApiOperation({ summary: 'Pause a sending or scheduled campaign' })
  async pause(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ) {
    const campaign = await this.campaigns.pause(auth.tenantId, id);
    audit.describe('campaign.paused', { campaignName: campaign.name });
    return campaign;
  }

  @Post(':id/resume')
  @ApiOperation({ summary: 'Resume a paused campaign' })
  async resume(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ) {
    const campaign = await this.campaigns.resume(auth.tenantId, id);
    audit.describe('campaign.resumed', { campaignName: campaign.name });
    return campaign;
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel a campaign; every remaining recipient is terminated',
  })
  async cancel(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ) {
    const campaign = await this.campaigns.cancel(auth.tenantId, id);
    audit.describe('campaign.canceled', { campaignName: campaign.name });
    return campaign;
  }

  /** A pure aggregate over `campaign_recipients` (D5) — the same rows the webhook layer writes. */
  @Get(':id/stats')
  @ApiOperation({ summary: 'Per-campaign delivery, read and reply counts' })
  async statsFor(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const stats = await this.stats.forCampaign(auth.tenantId, id);
    if (!stats) throw new NotFoundException(`Campaign ${id} not found`);
    return stats;
  }

  @Get(':id/recipients')
  @ApiOperation({ summary: 'The campaign recipient snapshot, paginated' })
  async recipients(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(listCampaignRecipientsQuerySchema))
    query: ListCampaignRecipientsQuery,
  ) {
    // 404s another tenant's campaign before any recipient read, and is
    // indistinguishable from "does not exist" by design.
    await this.campaigns.require(auth.tenantId, id);
    return this.stats.listRecipients(auth.tenantId, id, {
      limit: query.limit,
      offset: query.offset,
      status: query.status,
    });
  }
}
