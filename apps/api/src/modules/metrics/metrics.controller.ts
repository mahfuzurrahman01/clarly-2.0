// Product shell (MetricsModule, A9 — Feature 5 scope): reporting is an
// admin surface, not an agent one — "no agent-performance dashboards this
// round" plus T14's own line ("Admin manages team, tenant config, and
// policy... Agent sees and acts on only their assigned/queue tickets")
// puts aggregate business metrics on the admin side of that split, unlike
// KanbanModule's ticket endpoints (Feature 5, Slice 3), which are
// deliberately ungated.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
  EscalationBreakdownDto,
  FirstResponseTimeResultDto,
  ResolutionRateResultDto,
  type EscalationBreakdown,
  type FirstResponseTimeResult,
  type ResolutionRateResult,
} from './metrics.dto';
import {
  dateRangeQuerySchema,
  knowledgeGapQuerySchema,
  DateRangeQueryDto,
  KnowledgeGapQueryDto,
  KnowledgeGapReportDto,
  type KnowledgeGapQuery,
} from './metrics.dto.zod';
import { MetricsService } from './metrics.service';
import {
  KnowledgeGapService,
  type KnowledgeGapReport,
} from './knowledge-gap.service';

@ApiTags('metrics')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@ApiValidationErrorResponse()
@Controller('metrics')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly knowledgeGaps: KnowledgeGapService,
  ) {}

  @Get('resolution-rate')
  @ApiOperation({
    summary: 'Resolution rate over a date range',
    description:
      'Share of the tenant conversations in the window that were resolved without escalation. Both `from` and `to` are required — omitting either returns 400. `resolutionRate` is 0, never NaN, when the window contains no conversations.',
  })
  @ApiOkResponse({ type: ResolutionRateResultDto })
  resolutionRate(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(dateRangeQuerySchema))
    query: DateRangeQueryDto,
  ): Promise<ResolutionRateResult> {
    return this.metrics.getResolutionRate(auth.tenantId, query);
  }

  @Get('escalation-breakdown')
  @ApiOperation({
    summary: 'Escalation reasons over a date range',
    description:
      'Ticket counts grouped by escalation reason for the window. Reasons with no tickets are omitted from the response rather than reported as 0.',
  })
  @ApiOkResponse({ type: EscalationBreakdownDto })
  escalationBreakdown(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(dateRangeQuerySchema))
    query: DateRangeQueryDto,
  ): Promise<EscalationBreakdown> {
    return this.metrics.getEscalationBreakdown(auth.tenantId, query);
  }

  @Get('first-response-time')
  @ApiOperation({
    summary: 'Median first-response time over a date range',
    description:
      'How long a customer waits for the first reply — their first message to the first answer that followed it, AI or human.\n\nMedian and p90 rather than a mean: the distribution has a long right tail (a message that arrives at 3am waits for business hours), and a mean would let those describe every customer.\n\n`medianMs`/`p90Ms` are null when no conversation closed in the window was ever replied to — that is an absent measurement, not an instant answer. `measuredConversations` is the denominator behind them.',
  })
  @ApiOkResponse({ type: FirstResponseTimeResultDto })
  firstResponseTime(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(dateRangeQuerySchema))
    query: DateRangeQueryDto,
  ): Promise<FirstResponseTimeResult> {
    return this.metrics.getFirstResponseTime(auth.tenantId, query);
  }

  @Get('knowledge-gaps')
  @ApiOperation({
    summary: 'Questions the agent could not answer',
    description:
      "The customer questions behind content-shaped escalations, newest first, with a count per reason for the whole window.\n\nOnly reasons a tenant can fix by writing or reconciling a document are included — `KB_NOT_INDEXED` (nothing covers it), `CONFIDENCE_BELOW_THRESHOLD` (covered badly) and `KB_CONFLICT` (two documents disagree). Tool, delivery and job failures are our problem or the BSP's, and listing them here would send a tenant off to fix something they cannot.\n\n`question` is null once the transcript has been purged (T16): the escalation still counts, the wording is simply gone.",
  })
  @ApiOkResponse({ type: KnowledgeGapReportDto })
  knowledgeGapReport(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(knowledgeGapQuerySchema))
    query: KnowledgeGapQuery,
  ): Promise<KnowledgeGapReport> {
    return this.knowledgeGaps.getReport(
      auth.tenantId,
      { from: query.from, to: query.to },
      query.limit,
    );
  }
}
