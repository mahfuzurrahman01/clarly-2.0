// F19 (Open Question 2, resolved 2026-09-21): the merchant-facing manual
// toggle for the marketing-only opt-out, distinct from the global opt-out
// CustomerConsentController owns. There is no unopt-out-of-marketing keyword
// in v1 (see the decision doc) — a merchant needs a way to record it the
// same way CustomerConsentController lets them record a global opt-out heard
// on a call, so this mirrors that controller's shape, keyed by customer id
// (like CustomerLabelController) rather than by phone, since the console
// already has the customer id open when this is used.
import {
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrorDto,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  CustomerConsentDto,
  setMarketingConsentBodySchema,
  type SetMarketingConsentBody,
  type CustomerConsentRecord,
} from './customer-consent.dto';
import { CustomerConsentService } from './customer-consent.service';
import { CustomerService } from './customer.service';

@ApiTags('customers')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@ApiResponse({
  status: 404,
  description: 'No such customer in the calling tenant.',
  type: ApiErrorDto,
})
@Controller('customers/:customerId/marketing-consent')
export class CustomerMarketingConsentController {
  constructor(
    private readonly consent: CustomerConsentService,
    private readonly customers: CustomerService,
  ) {}

  @Patch()
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: "Set a customer's marketing-only opt-out",
    description:
      'Marketing consent is narrower than the global opt-out CustomerConsentController manages: setting it here stops campaign sends without touching template/service messaging. Setting it false clears the marketing-only flag but never clears a global opt-out — the two are independent, and a customer who has a global opt-out set stays fully blocked regardless of this value.',
  })
  @ApiParam({
    name: 'customerId',
    format: 'uuid',
    description:
      'Customer id. A non-UUID value is rejected with 400 by ParseUUIDPipe; a customer belonging to another tenant returns 404, never 403.',
  })
  @ApiOkResponse({ type: CustomerConsentDto })
  @ApiValidationErrorResponse()
  async set(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(setMarketingConsentBodySchema))
    body: SetMarketingConsentBody,
    @Audit() audit: AuditDetail,
  ): Promise<CustomerConsentRecord> {
    await this.requireCustomer(auth.tenantId, customerId);
    const record = await this.consent.setMarketingOptOut(
      auth.tenantId,
      customerId,
      body.optedOut,
    );
    if (!record) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }
    audit.describe(
      body.optedOut
        ? 'marketing_consent.opted_out'
        : 'marketing_consent.cleared',
      { customerId },
    );
    return record;
  }

  private async requireCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    const customer = await this.customers.getCustomer(tenantId, customerId);
    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }
  }
}
