// F25 D7: the console's order surface — read, and the four transitions.
//
// ROUTE ORDER IS LOAD-BEARING. `/orders/settings` is declared on a SEPARATE
// controller (`OrderSettingsController`) whose `@Controller('orders/settings')`
// path is more specific than this one's `:id`, and Nest resolves the more
// specific path first. The controller-spec asserts it, because F20's P1-1 was
// exactly this shadowing and no service-level test could see it.
//
// Not-found and cross-tenant ids both return 404, never 403 or 500 (F20's
// P1-3): under RLS we genuinely cannot see another tenant's row, so "yours and
// missing" and "someone else's" are the same answer, and telling them apart
// would be an existence oracle.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { InvalidOrderTransitionFilter } from './invalid-order-transition.filter';
import { OrderApprovalService } from './order-approval.service';
import {
  listOrdersQuerySchema,
  rejectOrderBodySchema,
  type ListOrdersQuery,
  type OrderPage,
  type OrderView,
  type RejectOrderBody,
} from './order.dto';
import { OrderService } from './order.service';

@ApiTags('Orders')
@ApiBearerAuth()
// D7: the four TRANSITIONS are entitlement-gated (they are "using the
// product"); the two reads are not — a lapsed tenant must still be able to
// see the orders they already took. Same split as
// `customer-label.controller.ts`.
@UseFilters(InvalidOrderTransitionFilter)
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly approvals: OrderApprovalService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List orders',
    description:
      "Newest first, cursor-paginated. Pass the previous page's `nextCursor` as `cursor`; a null `nextCursor` means this was the last page. Ungated by role — approving an order is working a conversation, which agents do.",
  })
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listOrdersQuerySchema)) query: ListOrdersQuery,
  ): Promise<OrderPage> {
    return this.orders.list(auth.tenantId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One order, with its line items',
    description:
      'Prices on the items are the SNAPSHOT taken when the order was placed, not the current catalogue price.',
  })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ order: OrderView; items: unknown[] }> {
    const result = await this.orders.get(auth.tenantId, id);
    if (!result) throw new NotFoundException(`Order ${id} not found`);
    return result;
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Approve a pending order',
    description:
      'Confirms the order, re-validates stock, tells the customer, and queues the store push if a store is connected. 409 if it is no longer pending or an item has gone out of stock since.',
  })
  async approve(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<OrderView> {
    const order = await this.approvals.approve(auth.tenantId, id, auth.userId);
    audit.describe('order.approved', {
      orderRef: order.reference,
      total: order.total,
      currency: order.currency,
    });
    return order;
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Reject a pending order',
    description:
      'The reason is recorded for the merchant and is NOT sent to the customer; the customer gets a neutral message.',
  })
  async reject(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rejectOrderBodySchema)) body: RejectOrderBody,
    @Audit() audit: AuditDetail,
  ): Promise<OrderView> {
    const order = await this.approvals.reject(
      auth.tenantId,
      id,
      auth.userId,
      body.reason,
    );
    audit.describe('order.rejected', {
      orderRef: order.reference,
      reason: body.reason,
    });
    return order;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Cancel a confirmed order',
    description:
      'From `confirmed` only. Phase 1 has no refunds and no order editing (F25 D3); the store is not told, because Clarly is authoritative and the merchant cancels their side.',
  })
  async cancel(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<OrderView> {
    const order = await this.approvals.cancel(auth.tenantId, id, auth.userId);
    audit.describe('order.cancelled', { orderRef: order.reference });
    return order;
  }

  @Post(':id/retry-store-push')
  @HttpCode(HttpStatus.OK)
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Re-queue a failed store push',
    description:
      'Only when `storeSyncStatus` is `failed`. The order itself is untouched — it was already real.',
  })
  async retryStorePush(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<OrderView> {
    const order = await this.approvals.retryStorePush(auth.tenantId, id);
    audit.describe('order.store_push_requeued', {
      orderRef: order.reference,
    });
    return order;
  }
}
