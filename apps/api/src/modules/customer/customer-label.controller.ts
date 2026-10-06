// Feature 18 (Intent Labeling): the CRM's read/override surface for a
// customer's label.
//
// Ungated by role, for the same reason the kanban board is (see
// kanban.controller.ts): T14 draws the admin/agent line at team/tenant-config/
// policy access, not at working a conversation. Correcting a wrong label is
// exactly the work an agent is doing while they read the ticket — an
// admin-only override would mean the person who spotted the mistake cannot fix
// it.
//
// The kanban ticket list and detail already carry `customerLabel` inline
// (TicketQueryService), so the console does not call GET here per card; this
// route exists for the customer-detail view and for re-reading after a write.
//
// Launch-integration fix (2026-09-17): PUT/DELETE are gated by
// EntitlementGuard, same as kanban ticket claim/assign/resolve — writing a
// label override is "using the product", not tenant-config/policy access
// (see the role note above, which is about a different axis). GET stays open.
import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Body,
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
  CustomerLabelDto,
  SetCustomerLabelBodyDto,
  setCustomerLabelBodySchema,
  type CustomerLabelRecord,
} from './customer-label.dto';
import { CustomerLabelService } from './customer-label.service';
import { CustomerService } from './customer.service';

const CUSTOMER_ID_PARAM = {
  name: 'customerId',
  format: 'uuid',
  description:
    'Customer id. A non-UUID value is rejected with 400 by ParseUUIDPipe; a customer belonging to another tenant returns 404, never 403 — cross-tenant ids are indistinguishable from non-existent ones by design.',
} as const;

@ApiTags('customers')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
@ApiResponse({
  status: 404,
  description: 'No such customer in the calling tenant.',
  type: ApiErrorDto,
})
@Controller('customers/:customerId/label')
export class CustomerLabelController {
  constructor(
    private readonly labels: CustomerLabelService,
    private readonly customers: CustomerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Read a customer's intent label",
    description:
      'The label in force, who it came from, and — when a human has overridden it — what the agent would say instead.\n\nReturns `null` for a customer the agent has never labelled and nobody has overridden. A customer that does not exist in this tenant returns 404, which is the distinction between "no label yet" and "no such customer".',
  })
  @ApiParam(CUSTOMER_ID_PARAM)
  @ApiOkResponse({ type: CustomerLabelDto })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<CustomerLabelRecord | null> {
    await this.requireCustomer(auth.tenantId, customerId);
    return this.labels.get(auth.tenantId, customerId);
  }

  @Put()
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: "Override a customer's intent label",
    description:
      'Pins the label to a human decision. From this point the agent stops writing the label for this customer — every subsequent turn leaves it alone — until the override is cleared with `DELETE`. That is the override-wins precedence rule, and it is enforced in the agent write path itself, not only when reading.\n\nThe agent keeps evaluating in the background: `agentLabel` and `agentEvaluatedAt` continue to update, so the console can show that the agent now disagrees with the pinned value.\n\nWorks on a customer the agent has never had a turn with — labelling someone you spoke to on the phone must not require the bot to have run first.',
  })
  @ApiParam(CUSTOMER_ID_PARAM)
  @ApiOkResponse({ type: CustomerLabelDto })
  @ApiValidationErrorResponse()
  async override(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(setCustomerLabelBodySchema))
    body: SetCustomerLabelBodyDto,
    @Audit() audit: AuditDetail,
  ): Promise<CustomerLabelRecord> {
    await this.requireCustomer(auth.tenantId, customerId);
    const record = await this.labels.override(
      auth.tenantId,
      customerId,
      body.label,
      auth.userId,
    );
    audit.describe('customer.label_overridden', {
      customerId,
      label: body.label,
    });
    return record;
  }

  @Delete()
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Clear a human override and hand the label back to the agent',
    description:
      "Removes the override marker. The label immediately becomes the agent's current opinion (`agentLabel`) rather than waiting for the customer's next message — a clear that visibly does nothing until an unpredictable future inbound message looks broken. Falls back to the pinned value when the agent has never evaluated this customer.\n\nReturns `null` when there was no label row to clear.",
  })
  @ApiParam(CUSTOMER_ID_PARAM)
  @ApiOkResponse({ type: CustomerLabelDto })
  async clearOverride(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Audit() audit: AuditDetail,
  ): Promise<CustomerLabelRecord | null> {
    await this.requireCustomer(auth.tenantId, customerId);
    const record = await this.labels.clearOverride(auth.tenantId, customerId);
    audit.describe('customer.label_cleared', { customerId });
    return record;
  }

  /**
   * 404s an id this tenant cannot see, BEFORE any label write touches it.
   *
   * The database already refuses the dangerous version of this — a label row
   * under the CALLER's tenant pointing at another tenant's customer violates
   * `customer_labels`' composite FK (see customer-labels.table.ts), and RLS
   * stops the caller reading the victim's rows either way. This check is about
   * the ANSWER the caller gets: without it, that attempt surfaces as a raw
   * foreign-key 500, which both leaks that the id exists somewhere and reads
   * as our bug rather than their bad request. A nonexistent customer and
   * someone else's customer must be indistinguishable, and both are a 404.
   */
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
