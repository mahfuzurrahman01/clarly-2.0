// F25 D7: the admin-only half of the order surface.
//
// The role split is the line already drawn in `kanban.controller.ts` and
// `customer-label.controller.ts`, and T14's own rule: approving an order is
// WORKING A CONVERSATION (any agent), switching a workspace into unattended
// ordering is TENANT CONFIGURATION (admin only).
//
// Its own controller, at the literal path `orders/settings`, rather than two
// routes on `OrderController`: Nest resolves the more specific declared path
// first, so `/orders/settings` can never be captured by `/orders/:id` and
// 400'd by `ParseUUIDPipe`. That was F20's P1-1, and a separate controller
// makes the shadowing structurally impossible rather than dependent on
// declaration order surviving the next edit.
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  updateOrderSettingsSchema,
  type UpdateOrderSettingsBody,
} from './order.dto';
import {
  OrderSettingsService,
  type AutoEligibility,
  type OrderSettingsRecord,
} from './order-settings.service';
import { OrderToolSeederService } from './order-tool-seeder.service';

export interface OrderSettingsResponse extends OrderSettingsRecord {
  /** Computed now, so a merchant can see exactly how far they are from unattended ordering. */
  autoEligibility: AutoEligibility;
}

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles('admin')
@Controller('orders/settings')
export class OrderSettingsController {
  constructor(
    private readonly settings: OrderSettingsService,
    private readonly toolSeeder: OrderToolSeederService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Order mode and auto-mode eligibility',
    description:
      'A workspace with no settings row reads as `disabled` — that is the default, and the agent cannot place an order in it under any prompt.',
  })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<OrderSettingsResponse> {
    const [settings, autoEligibility] = await Promise.all([
      this.settings.get(auth.tenantId),
      this.settings.evaluateAutoEligibility(auth.tenantId),
    ]);
    return { ...settings, autoEligibility };
  }

  @Patch()
  @ApiOperation({
    summary: 'Change the order mode',
    description:
      'Moving to `auto` returns 422, naming the failing criterion, unless all five of F25 D1.5 hold at the moment of the call. Audited by the global audit interceptor.',
  })
  async update(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(updateOrderSettingsSchema))
    body: UpdateOrderSettingsBody,
    @Audit() audit: AuditDetail,
  ): Promise<OrderSettingsResponse> {
    const settings = await this.settings.update(
      auth.tenantId,
      auth.userId,
      body,
    );

    // Gate 1 follows the mode, always — including back to `disabled`, which
    // DISABLES the tenant_tools row so the model stops being told the tool
    // exists. Best-effort: a registry write that fails leaves the tenant more
    // restricted than they asked for, never less, and the execution gate
    // covers the other direction.
    await this.toolSeeder.syncForModeBestEffort(auth.tenantId, settings.mode);

    // D1.5: "who turned this on and what did the numbers look like" must be
    // answerable a year later. The snapshot is on the row; this is the
    // audit_log half.
    audit.describe('order_settings.updated', {
      mode: settings.mode,
      cod: settings.codEnabled ? 'enabled' : 'disabled',
      approvalWindowHours: settings.approvalWindowHours,
    });

    const autoEligibility = await this.settings.evaluateAutoEligibility(
      auth.tenantId,
    );
    return { ...settings, autoEligibility };
  }
}
