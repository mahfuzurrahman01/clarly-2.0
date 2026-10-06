// Product shell (BillingModule, Lane A/frontend contract request): the one
// unauthenticated read in this module. `/pricing` is a signed-out marketing
// page — it cannot carry a tenant JWT, so it cannot go through
// `BillingController` (admin-gated, and covered by `TenantAuthMiddleware`
// in `BillingModule.configure()`). A SEPARATE controller class, not a
// second route on `BillingController`, is what actually gets this outside
// that middleware: Nest's `TenantAuthMiddleware.forRoutes(BillingController)`
// applies to every route on that controller class, so a public route needs
// its own class the same way `SignupController`/`HealthController` do for
// their own no-tenant-yet/no-auth-at-all cases.
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { PublicPlanListDto, type PublicPlanRecord } from './billing.dto';

@ApiTags('billing')
@Controller('billing/plans/public')
export class BillingPublicController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({
    summary: 'List subscription plans (public, unauthenticated)',
    description:
      "The platform-wide plan catalog, for signed-out surfaces like /pricing. Same rows as the admin-only `GET /billing/plans`, minus `stripePriceId` (an internal identifier a visitor has no use for and shouldn't see). No auth required — do not add tenant/billing details to this response.",
  })
  @ApiOkResponse({ type: PublicPlanListDto })
  listPublicPlans(): Promise<PublicPlanRecord[]> {
    return this.billing.listPublicPlans();
  }
}
