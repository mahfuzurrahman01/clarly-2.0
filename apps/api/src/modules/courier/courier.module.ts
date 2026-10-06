// F26 (Delivery Tracking — Aramex, SMSA, Naqel, J&T). Spec:
// docs/decisions/F26-delivery-tracking.md.
//
// Module-boundary notes:
//   - NO raw DB access. Every tenant-scoped query goes through
//     `TenantContextService.withTenantTx()`; the only two `runAdminQuery`
//     uses are the genuinely pre-tenant reads (webhook routing by
//     (courier, account_ref), and the poll sweep's connection/shipment scan),
//     both with explicit predicates and both re-entering `withTenantTx` for
//     every write. F24 injected a `PostgresJsDatabase` this app does not even
//     provide, which would have bypassed RLS entirely.
//   - WhatsappModule is imported for exactly one thing:
//     `BspCredentialsEncryptionService` — the platform's channel-credential
//     cipher, reused for courier credentials rather than standing up a second
//     AES-GCM path.
//   - TemplatesModule supplies `TemplateSendService`, the shared half of the
//     human and automated template send paths (D5). This module does NOT
//     import InboxModule: the human send path is not what an automated
//     notification needs.
//   - Import direction for the tool: ToolExecutionModule -> CourierModule,
//     and this module imports only the `ToolDefinition` TYPE back. Same as
//     `catalog/` and `order/`; no runtime cycle.
//   - OrderModule is imported for `OrderService.get()` only, so the manual
//     shipment-creation endpoint can validate an `orderId` belongs to this
//     tenant and read the order's `customerId` to denormalize onto the
//     shipment row (D4's authorization predicate). OrderModule does not
//     import CourierModule back — one-way, same shape as
//     `OrderModule -> StoreModule`.
//   - TenantAuthMiddleware is applied to CourierController ONLY. The webhook
//     controller is unauthenticated by nature — a courier has no JWT — and
//     its trust comes from the per-connection digest.
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { ConversationModule } from '../conversation/conversation.module';
import { CustomerModule } from '../customer/customer.module';
import { NotificationRecordModule } from '../notifications/notification-record.module';
import { OrderModule } from '../order/order.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TemplatesModule } from '../templates/templates.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CourierConnectionService } from './courier-connection.service';
import { CourierConnectorRegistry } from './courier-connector.registry';
import { CourierController } from './courier.controller';
import { CourierToolSeederService } from './courier-tool-seeder.service';
import { CourierWebhookController } from './courier-webhook.controller';
import { CourierWebhookEventStore } from './courier-webhook-event.store';
import { CourierWebhookService } from './courier-webhook.service';
import { DeliveryNotificationProcessor } from './delivery-notification.processor';
import {
  DELIVERY_NOTIFICATION_ATTEMPTS,
  DELIVERY_NOTIFICATION_QUEUE,
} from './delivery-notification.queue';
import { DeliveryNotificationQueueService } from './delivery-notification.queue-service';
import { DeliveryNotificationService } from './delivery-notification.service';
import { DeliveryNotificationSettingsService } from './delivery-notification-settings.service';
import { ShipmentNotificationStore } from './shipment-notification.store';
import { ShipmentPollProcessor } from './shipment-poll.processor';
import { SHIPMENT_POLL_QUEUE } from './shipment-poll.queue';
import { ShipmentPollSchedulerService } from './shipment-poll-scheduler.service';
import { ShipmentPollService } from './shipment-poll.service';
import { ShipmentRefreshQueueService } from './shipment-refresh.queue-service';
import { ShipmentService } from './shipment.service';
import { TrackOrderExecutor } from './track-order-executor';
import { AramexConnector } from './ports/aramex.connector';
import { JtConnector } from './ports/jt.connector';
import { NaqelConnector } from './ports/naqel.connector';
import { NoopCourierConnector } from './ports/noop-courier.connector';
import { SmsaConnector } from './ports/smsa.connector';

export { CourierConnectionService } from './courier-connection.service';
export { CourierToolSeederService } from './courier-tool-seeder.service';
export { CourierWebhookService } from './courier-webhook.service';
export { DeliveryNotificationService } from './delivery-notification.service';
export { DeliveryNotificationSettingsService } from './delivery-notification-settings.service';
export { ShipmentService } from './shipment.service';
export { ShipmentPollService } from './shipment-poll.service';
export { TrackOrderExecutor } from './track-order-executor';
export { trackOrderToolDefinition, TrackOrderInput } from './track-order.tool';
export type { TrackOrderResult } from './track-order-executor';

@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    AuthModule,
    AuditModule,
    BillingModule,
    // Consent lives here (CustomerConsentService, via TemplatesModule) and so
    // does the customer's phone number, which a notification needs.
    CustomerModule,
    // The thread a proactive notification lands in — a customer who has never
    // messaged still gets one, so the update is in the transcript the next
    // human reads.
    ConversationModule,
    // The shared send path (D5).
    TemplatesModule,
    // BspCredentialsEncryptionService.
    WhatsappModule,
    NotificationRecordModule,
    // OrderService.get() — the manual shipment-creation endpoint's order
    // lookup (tenant-scoped existence check + customerId).
    OrderModule,
    ToolRegistryModule,
    QueueModule,
    BullModule.registerQueue({
      name: SHIPMENT_POLL_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        // The failed set IS the de facto DLQ (T11's convention).
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: DELIVERY_NOTIFICATION_QUEUE,
      defaultJobOptions: {
        attempts: DELIVERY_NOTIFICATION_ATTEMPTS,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [CourierController, CourierWebhookController],
  providers: [
    CourierConnectionService,
    CourierConnectorRegistry,
    CourierToolSeederService,
    CourierWebhookEventStore,
    CourierWebhookService,
    DeliveryNotificationQueueService,
    DeliveryNotificationProcessor,
    DeliveryNotificationService,
    DeliveryNotificationSettingsService,
    ShipmentNotificationStore,
    ShipmentPollProcessor,
    ShipmentPollSchedulerService,
    ShipmentPollService,
    ShipmentRefreshQueueService,
    ShipmentService,
    TrackOrderExecutor,
    AramexConnector,
    SmsaConnector,
    NaqelConnector,
    JtConnector,
    NoopCourierConnector,
  ],
  exports: [
    CourierConnectionService,
    CourierToolSeederService,
    CourierWebhookService,
    DeliveryNotificationService,
    DeliveryNotificationSettingsService,
    ShipmentService,
    ShipmentPollService,
    TrackOrderExecutor,
  ],
})
export class CourierModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(CourierController);
  }
}
