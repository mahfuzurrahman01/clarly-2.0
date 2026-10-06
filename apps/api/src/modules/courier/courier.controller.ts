// F26 (Delivery Tracking): the authenticated console API (D9).
//
// There is no OAuth flow and therefore no unauthenticated credential-entry
// path — that is the structural difference from F24, whose cross-tenant store
// hijack was an OAuth callback taking the tenant from an unauthenticated
// query param. Credentials arrive here, behind TenantAuthMiddleware (wired in
// CourierModule.configure) plus the admin role gate, with `tenantId` from the
// bearer token. There is no state parameter to forge because there is no
// redirect.
//
// Every write body goes through `ZodValidationPipe`, and a not-found path
// throws `NotFoundException` — never `throw new Error` — with the SAME
// message for "does not exist" and "belongs to another tenant".
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Audit, type AuditDetail } from '../audit/audit-detail';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { CourierConnectionService } from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import { CourierCallGuard } from './courier-call';
import { DeliveryNotificationSettingsService } from './delivery-notification-settings.service';
import { ShipmentService } from './shipment.service';
import { OrderService } from '../order/order.service';
import {
  CourierAuthenticationError,
  type CourierConnector,
} from './ports/courier-connector.port';
import {
  CourierConnectionDto,
  CreateShipmentBodyDto,
  DeliveryNotificationSettingsDto,
  ShipmentDto,
  UpsertCourierConnectionBodyDto,
  createShipmentSchema,
  updateDeliveryNotificationSettingsSchema,
  upsertCourierConnectionSchema,
  type CourierConnectionDtoShape,
  type ShipmentDtoShape,
  type UpdateDeliveryNotificationSettingsBody,
} from './courier.dto';

const CONNECTION_NOT_FOUND = 'Courier connection not found';

@ApiTags('Couriers')
@ApiBearerAuth()
@UseGuards(RolesGuard, EntitlementGuard)
@Controller()
export class CourierController {
  private readonly verifyGuard = new CourierCallGuard();

  constructor(
    private readonly connections: CourierConnectionService,
    private readonly registry: CourierConnectorRegistry,
    private readonly shipments: ShipmentService,
    private readonly settings: DeliveryNotificationSettingsService,
    private readonly orders: OrderService,
  ) {}

  /**
   * Create or update a courier connection.
   *
   * D1: the credentials are VALIDATED LIVE before the connection is stored
   * active. F24 shipped connections that had never made a real provider call,
   * which is how "no Salla call has ever been made" became a launch blocker.
   * A rejection stores the row with `is_active = false` and answers 400, so
   * the merchant sees what they typed and what the courier said about it.
   */
  @Post('couriers/connections')
  @Roles('admin')
  @ApiOperation({
    summary: 'Create or update a courier connection (validates credentials)',
  })
  @ApiOkResponse({ type: CourierConnectionDto })
  async upsertConnection(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(upsertCourierConnectionSchema))
    body: UpsertCourierConnectionBodyDto,
    @Audit() audit: AuditDetail,
  ): Promise<CourierConnectionDtoShape & { verificationError?: string }> {
    const connector = this.registry.forCourier(body.courier);

    let verificationError: string | undefined;
    try {
      await this.verifyGuard.run(
        `verify:${auth.tenantId}:${body.courier}`,
        () => connector.verifyCredentials(body.credentials),
      );
    } catch (error) {
      verificationError =
        error instanceof CourierAuthenticationError
          ? error.message
          : `could not reach ${body.courier} to verify these credentials: ${
              error instanceof Error ? error.message : String(error)
            }`;
    }

    const connection = await this.connections.upsert({
      tenantId: auth.tenantId,
      courier: body.courier,
      accountRef: body.accountRef,
      credentials: body.credentials,
      isActive: verificationError === undefined,
      // A courier we accept push from needs a secret the moment it is
      // connected; a poll-only courier must not have one at all, because a
      // stored secret would make the "we do not accept push here" decision
      // look like a configuration gap.
      webhookSecret:
        connector.webhookSignatureHeader === null
          ? null
          : CourierConnectionService.generateWebhookSecret(),
    });

    audit.describe(
      verificationError ? 'courier.saved_inactive' : 'courier.connected',
      { courier: body.courier, accountRef: body.accountRef },
    );

    return {
      ...toConnectionDto(connection, connector),
      ...(verificationError ? { verificationError } : {}),
    };
  }

  /** Never returns credentials or the webhook secret. */
  @Get('couriers/connections')
  @ApiOperation({ summary: "List the workspace's courier connections" })
  @ApiOkResponse({ type: [CourierConnectionDto] })
  async listConnections(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<CourierConnectionDtoShape[]> {
    const connections = await this.connections.findByTenant(auth.tenantId);
    return connections.map((connection) =>
      toConnectionDto(connection, this.registry.forCourier(connection.courier)),
    );
  }

  @Delete('couriers/connections/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Deactivate a courier connection' })
  async deactivate(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<{ success: true }> {
    const deactivated = await this.connections.deactivate(auth.tenantId, id);
    if (!deactivated) throw new NotFoundException(CONNECTION_NOT_FOUND);
    audit.describe('courier.deactivated', { connectionId: id });
    return { success: true };
  }

  /** Rotates and reveals the per-connection webhook secret ONCE. */
  @Post('couriers/connections/:id/webhook-secret')
  @Roles('admin')
  @ApiOperation({
    summary: "Rotate and reveal this connection's webhook secret (shown once)",
  })
  async rotateWebhookSecret(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Audit() audit: AuditDetail,
  ): Promise<{ webhookSecret: string }> {
    const existing = await this.connections.findById(auth.tenantId, id);
    if (!existing) throw new NotFoundException(CONNECTION_NOT_FOUND);
    if (
      this.registry.forCourier(existing.courier).webhookSignatureHeader === null
    ) {
      // Minting a secret for a courier whose push we refuse would suggest the
      // push works. It does not, and never will for that courier (D1).
      throw new NotFoundException(
        `${existing.courier} has no push callback surface this platform accepts; it is polled instead.`,
      );
    }

    const secret = await this.connections.rotateWebhookSecret(
      auth.tenantId,
      id,
    );
    if (!secret) throw new NotFoundException(CONNECTION_NOT_FOUND);
    audit.describe('courier.webhook_secret_rotated', { connectionId: id });
    return { webhookSecret: secret };
  }

  /**
   * Manual shipment creation: the merchant console records a tracking number
   * against an order once it has been handed to a courier. This does not
   * call the courier — it only tells the platform a shipment now exists, so
   * `track_order` (D4) has a row to answer from and the poll sweep (D5) has
   * something to refresh. Until this endpoint existed, `track_order` could
   * only ever answer "no shipment", because nothing wrote to `shipments`.
   *
   * `orderId` must resolve inside this tenant (same 404-not-403 rule as
   * `OrderController.get`, F20's P1-3) and `courierConnectionId` must be an
   * ACTIVE connection owned by this tenant whose `courier` matches the body
   * — a mismatched pair would point the poller at credentials for the wrong
   * network and it would never successfully track. `customerId` is
   * denormalized from the order, never accepted as input (D4's
   * authorization predicate lives on this column and must not be
   * caller-suppliable).
   */
  @Post('orders/:orderId/shipments')
  @Roles('admin')
  @ApiOperation({ summary: 'Record a shipment against an order' })
  @ApiOkResponse({ type: ShipmentDto })
  async createShipment(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body(new ZodValidationPipe(createShipmentSchema))
    body: CreateShipmentBodyDto,
    @Audit() audit: AuditDetail,
  ): Promise<ShipmentDtoShape> {
    const order = await this.orders.get(auth.tenantId, orderId);
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    const connection = await this.connections.findById(
      auth.tenantId,
      body.courierConnectionId,
    );
    if (!connection) throw new NotFoundException(CONNECTION_NOT_FOUND);
    if (!connection.isActive) {
      throw new BadRequestException(
        `Courier connection ${body.courierConnectionId} is not active`,
      );
    }
    if (connection.courier !== body.courier) {
      throw new BadRequestException(
        `Courier connection ${body.courierConnectionId} is a ${connection.courier} connection, not ${body.courier}`,
      );
    }

    const shipment = await this.shipments.create({
      tenantId: auth.tenantId,
      orderId: order.order.id,
      customerId: order.order.customerId,
      courierConnectionId: connection.id,
      courier: body.courier,
      trackingNumber: body.trackingNumber,
    });

    audit.describe('shipment.recorded', {
      courier: body.courier,
      trackingNumber: body.trackingNumber,
      orderRef: order.order.reference,
    });

    return {
      id: shipment.id,
      orderId: shipment.orderId,
      courier: shipment.courier,
      trackingNumber: shipment.trackingNumber,
      currentStatus: shipment.currentStatus,
      currentStatusAt: shipment.currentStatusAt,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt,
      deliveredAt: shipment.deliveredAt,
      lastNotifiedStatus: shipment.lastNotifiedStatus,
      lastNotifiedAt: shipment.lastNotifiedAt,
      lastPolledAt: shipment.lastPolledAt,
      pollFailureCount: shipment.pollFailureCount,
      history: [],
    };
  }

  /**
   * The console's shipment view for an order, with full history.
   *
   * Tenant-scoped only — this is a staff surface. The customer-scoped path is
   * `track_order`, and the two must not share a reader: widening this one by
   * accident would be a data leak, widening that one would be a much worse
   * data leak.
   */
  @Get('orders/:orderId/shipments')
  @ApiOperation({ summary: "An order's shipments, with status history" })
  @ApiOkResponse({ type: [ShipmentDto] })
  async listOrderShipments(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ShipmentDtoShape[]> {
    const shipments = await this.shipments.findByOrder(auth.tenantId, orderId);
    return Promise.all(
      shipments.map(async (shipment) => {
        const history = await this.shipments.history(
          auth.tenantId,
          shipment.id,
        );
        return {
          id: shipment.id,
          orderId: shipment.orderId,
          courier: shipment.courier,
          trackingNumber: shipment.trackingNumber,
          currentStatus: shipment.currentStatus,
          currentStatusAt: shipment.currentStatusAt,
          estimatedDeliveryAt: shipment.estimatedDeliveryAt,
          deliveredAt: shipment.deliveredAt,
          lastNotifiedStatus: shipment.lastNotifiedStatus,
          lastNotifiedAt: shipment.lastNotifiedAt,
          lastPolledAt: shipment.lastPolledAt,
          pollFailureCount: shipment.pollFailureCount,
          history: history.map((event) => ({
            status: event.status,
            rawStatus: event.rawStatus,
            location: event.location,
            occurredAt: event.occurredAt,
            source: event.source,
          })),
        };
      }),
    );
  }

  @Get('settings/delivery-notifications')
  @ApiOperation({ summary: 'Proactive shipment-update settings' })
  @ApiOkResponse({ type: DeliveryNotificationSettingsDto })
  async getSettings(@CurrentAuth() auth: TenantAuthContext) {
    const settings = await this.settings.get(auth.tenantId);
    return {
      enabled: settings.enabled,
      statusTemplates: settings.statusTemplates,
      updatedAt: settings.updatedAt,
    };
  }

  @Put('settings/delivery-notifications')
  @Roles('admin')
  @ApiOperation({
    summary: 'Turn proactive shipment updates on and map statuses to templates',
  })
  @ApiOkResponse({ type: DeliveryNotificationSettingsDto })
  async updateSettings(
    @CurrentAuth() auth: TenantAuthContext,
    @Body(new ZodValidationPipe(updateDeliveryNotificationSettingsSchema))
    body: UpdateDeliveryNotificationSettingsBody,
    @Audit() audit: AuditDetail,
  ) {
    const settings = await this.settings.upsert(auth.tenantId, {
      enabled: body.enabled,
      statusTemplates: body.statusTemplates,
    });
    audit.describe(
      body.enabled
        ? 'delivery_notifications.enabled'
        : 'delivery_notifications.disabled',
      { mappedStatuses: Object.keys(body.statusTemplates).length },
    );
    return {
      enabled: settings.enabled,
      statusTemplates: settings.statusTemplates,
      updatedAt: settings.updatedAt,
    };
  }
}

function toConnectionDto(
  connection: {
    id: string;
    courier: string;
    accountRef: string;
    isActive: boolean;
    webhookSecret: string | null;
    lastVerifiedAt: Date | null;
    lastPolledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  connector: CourierConnector,
): CourierConnectionDtoShape {
  return {
    id: connection.id,
    courier: connection.courier as CourierConnectionDtoShape['courier'],
    accountRef: connection.accountRef,
    isActive: connection.isActive,
    supportsWebhook: connector.webhookSignatureHeader !== null,
    // The BOOLEAN, never the secret. It is readable exactly once, from the
    // rotate endpoint, and never again.
    hasWebhookSecret: connection.webhookSecret !== null,
    lastVerifiedAt: connection.lastVerifiedAt,
    lastPolledAt: connection.lastPolledAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
