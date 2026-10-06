// Product shell (BillingModule, Feature 8/T19): admin-only, same T14 split
// as MetricsController/TenantPolicyController — billing is a tenant-config
// concern, not a per-ticket agent action.
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
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
import { BillingService } from './billing.service';
import {
  BillingPortalSessionDto,
  PlanListDto,
  StartSubscriptionResultDto,
  TenantSubscriptionRecordDto,
  type BillingPortalSession,
  type PlanRecord,
  type StartSubscriptionResult,
  type TenantSubscriptionRecord,
} from './billing.dto';
import {
  billingPortalBodySchema,
  BillingPortalBodyDto,
  cancelSubscriptionBodySchema,
  CancelSubscriptionBodyDto,
  startCheckoutBodySchema,
  StartCheckoutBodyDto,
} from './checkout.dto.zod';
import { UsageService } from './usage.service';
import { MonthlyUsageResultDto, type MonthlyUsageResult } from './usage.dto';

@ApiTags('billing')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('billing')
@UseGuards(RolesGuard)
@Roles('admin')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly usage: UsageService,
  ) {}

  @Get('plans')
  @ApiOperation({
    summary: 'List subscription plans',
    description:
      'The platform-wide plan catalog. Not tenant-scoped — every tenant sees the same list. Use a plan `id` from here as the `planId` for `POST /billing/checkout`.',
  })
  @ApiOkResponse({ type: PlanListDto })
  listPlans(): Promise<PlanRecord[]> {
    return this.billing.listPlans();
  }

  /** T20: "a monthly usage report reconciles against agent_runs' recorded cost." Current calendar month only this pass — no historical month picker yet. */
  @Get('usage')
  @ApiOperation({
    summary: 'Get this month usage',
    description:
      'Message count, token totals, and cost for the calling tenant, for the current calendar month only — there is no historical month picker yet. Figures reconcile against the `agent_runs` cost ledger.',
  })
  @ApiOkResponse({ type: MonthlyUsageResultDto })
  getUsage(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<MonthlyUsageResult> {
    return this.usage.getMonthlyUsage(auth.tenantId);
  }

  @Get('subscription')
  @ApiOperation({
    summary: 'Get current subscription',
    description:
      "The calling tenant's subscription row. Returns `null` (200, empty body) when the tenant has never started checkout — that is the normal pre-billing state, not an error.",
  })
  @ApiOkResponse({
    type: TenantSubscriptionRecordDto,
    description: 'The subscription record, or `null` if the tenant has none.',
  })
  getSubscription(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<TenantSubscriptionRecord | null> {
    return this.billing.getForTenant(auth.tenantId);
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Start a Stripe checkout session',
    description:
      'Creates a Stripe checkout session for the calling tenant and returns its hosted URL. The subscription is not active until Stripe calls back on `POST /billing/webhook` — this response only means the session was created.',
  })
  @ApiCreatedResponse({ type: StartSubscriptionResultDto })
  @ApiValidationErrorResponse()
  startCheckout(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(startCheckoutBodySchema))
    body: StartCheckoutBodyDto,
  ): Promise<StartSubscriptionResult> {
    return this.billing.startSubscription(
      auth.tenantId,
      body.planId,
      body.email,
      body.successUrl,
      body.cancelUrl,
    );
  }

  @Post('portal')
  @ApiOperation({
    summary: 'Open the Stripe billing portal',
    description:
      'Returns a Stripe-hosted billing portal URL for the calling tenant — redirect the browser to it. One page covers changing the payment card, downloading past invoices, and cancelling.\n\nDeliberately not reimplemented in this API: the portal is PCI-handled, localized, and kept current by Stripe, and rebuilding it would mean holding card details this system has no business seeing.\n\nThe URL is single-use and short-lived — generate one per visit rather than caching it.\n\n409 when the tenant has never subscribed: nothing is wrong with the request, there is just no billing relationship to manage yet.',
  })
  @ApiCreatedResponse({ type: BillingPortalSessionDto })
  @ApiConflictResponse({
    description: 'This tenant has no billing relationship yet.',
  })
  @ApiValidationErrorResponse()
  openPortal(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(billingPortalBodySchema))
    body: BillingPortalBodyDto,
  ): Promise<BillingPortalSession> {
    return this.billing.createPortalSession(auth.tenantId, body.returnUrl);
  }

  @Post('cancel')
  @ApiOperation({
    summary: 'Cancel the subscription',
    description:
      "Cancels the calling tenant's subscription and returns the updated record.\n\nBy default (`atPeriodEnd: true`) the subscription keeps running until the period already paid for runs out. **`status` stays `active` for that whole time** — that is Stripe's behaviour, not a bug — so `cancelAtPeriodEnd` is the field that tells you the tenant is leaving, and `currentPeriodEnd` is when access stops. Pass `atPeriodEnd: false` to end it immediately and forfeit the remainder.\n\nThe change is written locally straight away, so the next `GET /billing/subscription` reflects it. Stripe's webhook arrives afterwards and writes the same values.\n\n404 when the tenant has no subscription at all. 409 when checkout was never completed (a Stripe customer exists but nothing is being billed) or the subscription is already cancelled.",
  })
  @ApiCreatedResponse({ type: TenantSubscriptionRecordDto })
  @ApiNotFoundResponse({ description: 'No subscription to cancel.' })
  @ApiConflictResponse({
    description: 'Nothing is being billed, or it is already cancelled.',
  })
  @ApiValidationErrorResponse()
  cancel(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(cancelSubscriptionBodySchema))
    body: CancelSubscriptionBodyDto,
  ): Promise<TenantSubscriptionRecord> {
    return this.billing.cancelSubscription(auth.tenantId, body.atPeriodEnd);
  }
}
