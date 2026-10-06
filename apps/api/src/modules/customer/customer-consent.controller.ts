// Reading and recording messaging consent from the console.
//
// The usual path is the customer typing STOP, which WebhookIngestService
// handles without anyone here being involved. This exists for the other way it
// happens: someone tells a human agent on the phone, or by email, and that has
// to be recordable — an opt-out honoured only when it arrives as a WhatsApp
// keyword is an opt-out we are choosing not to hear.
import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAdminOnlyResponses,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import {
  CustomerConsentDto,
  SetConsentBodyDto,
  setConsentBodySchema,
  type CustomerConsentRecord,
} from './customer-consent.dto';
import { CustomerConsentService } from './customer-consent.service';

@ApiTags('customers')
@ApiBearerAuth()
@ApiAdminOnlyResponses()
@Controller('customers/consent')
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
export class CustomerConsentController {
  constructor(private readonly consent: CustomerConsentService) {}

  @Get()
  @ApiOperation({
    summary: "Read a customer's messaging consent",
    description:
      'Whether this phone number has opted out, when, and how it was recorded. Returns `null` for a number we have never heard from — a customer we have no record of cannot have asked us to stop.',
  })
  @ApiQuery({ name: 'phone', required: true })
  @ApiOkResponse({ type: CustomerConsentDto })
  get(
    @CurrentAuth() auth: TenantAuthContext,
    @Query('phone') phone: string,
  ): Promise<CustomerConsentRecord | null> {
    return this.consent.get(auth.tenantId, phone);
  }

  @Put()
  @ApiOperation({
    summary: "Record a customer's messaging consent",
    description:
      'Sets or clears an opt-out on behalf of a customer who told you outside WhatsApp — on a call, by email, in person. Recorded with source `admin`, distinct from the `customer_keyword` a STOP message produces, because those are different answers to "how do you know".\n\nCreates the customer record if this number has never been seen, so an opt-out is never lost for want of a profile.\n\n**What an opt-out blocks:** agent auto-replies and template sends. **What it does not block:** a human replying inside the 24-hour service window, and recording the customer\'s own inbound messages. A customer who opted out and then messages again has re-opened that window themselves; refusing to let a human answer would leave them unable to reach anyone.\n\nSetting `optedOut: false` records consent to be messaged again. Note that a customer simply messaging again does **not** do this — inferring consent from a message is exactly the inference that gets businesses fined.',
  })
  @ApiOkResponse({ type: CustomerConsentDto })
  @ApiValidationErrorResponse()
  async set(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(setConsentBodySchema))
    body: SetConsentBodyDto,
    @Audit() audit: AuditDetail,
  ): Promise<CustomerConsentRecord> {
    const record = body.optedOut
      ? await this.consent.recordOptOut(auth.tenantId, body.phone, 'admin')
      : await this.consent.recordOptIn(auth.tenantId, body.phone);

    audit.describe(body.optedOut ? 'consent.opted_out' : 'consent.opted_in', {
      phone: body.phone,
    });
    return record;
  }
}
