// F25 (Orders in Chat + Complaints), D8.
//
// Import direction, and why there is no cycle:
//   ToolExecutionModule -> OrderModule (for `CreateOrderExecutor`), and
//   OrderModule imports only the `ToolDefinition` TYPE back — identical to how
//   `catalog/` and `store/` already register their tools.
//   StoreModule must NOT import OrderModule. This module imports StoreModule
//   for connection/OAuth/provider access, which is the one-way direction D4
//   requires: Clarly's `orders` is authoritative, the store is a sync target.
//
// Module-boundary rules (AI_PIPELINE_PLAN.md's four): no raw DB access here.
// Every query goes through `TenantContextService.withTenantTx()`, and the one
// pre-tenant read — the expiry sweep learning which tenants to enter — goes
// through `PersistenceService.runAdminQuery`, the documented carve-out.
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InboxModule } from '../inbox/inbox.module';
import { NotificationRecordModule } from '../notifications/notification-record.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { StoreModule } from '../store/store.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { CreateOrderExecutor } from './create-order-executor';
import { OrderApprovalService } from './order-approval.service';
import { OrderController } from './order.controller';
import { OrderExpiryProcessor } from './order-expiry.processor';
import { ORDER_EXPIRY_QUEUE } from './order-expiry.queue';
import { OrderExpirySchedulerService } from './order-expiry-scheduler.service';
import { OrderExpiryService } from './order-expiry.service';
import { OrderService } from './order.service';
import { OrderSettingsController } from './order-settings.controller';
import { OrderSettingsService } from './order-settings.service';
import { OrderStorePushProcessor } from './order-store-push.processor';
import {
  ORDER_STORE_PUSH_ATTEMPTS,
  ORDER_STORE_PUSH_QUEUE,
} from './order-store-push.queue';
import { OrderStorePushService } from './order-store-push.service';
import { OrderToolSeederService } from './order-tool-seeder.service';

export { CreateOrderExecutor } from './create-order-executor';
export { OrderService } from './order.service';
export { OrderApprovalService } from './order-approval.service';
export { OrderSettingsService } from './order-settings.service';
export { OrderStorePushService } from './order-store-push.service';
export { OrderToolSeederService } from './order-tool-seeder.service';
export { createOrderToolDefinition } from './create-order.tool';
export type { CreateOrderInput } from './create-order.tool';
export type { CreateOrderToolResult } from './create-order-executor';

@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    AuthModule,
    BillingModule,
    // Product resolution for the price snapshot. The executor reads `products`
    // through its own transaction, but the module dependency is what keeps the
    // relationship explicit.
    CatalogModule,
    // StoreConnectionService / StoreOAuthService / StoreProviderRegistry for
    // the asynchronous push. One-way: StoreModule knows nothing about orders.
    StoreModule,
    ToolRegistryModule,
    NotificationRecordModule,
    // HumanReplyService — the path a human agent's reply already takes.
    InboxModule,
    QueueModule,
    BullModule.registerQueue({
      name: ORDER_STORE_PUSH_QUEUE,
      defaultJobOptions: {
        attempts: ORDER_STORE_PUSH_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        // The failed set IS the de facto DLQ (T11's convention), and a push
        // that exhausted its attempts is something an operator must be able to
        // find.
        removeOnFail: false,
      },
    }),
    BullModule.registerQueue({
      name: ORDER_EXPIRY_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [OrderSettingsController, OrderController],
  providers: [
    OrderService,
    OrderApprovalService,
    OrderSettingsService,
    OrderToolSeederService,
    OrderStorePushService,
    OrderStorePushProcessor,
    OrderExpiryService,
    OrderExpiryProcessor,
    OrderExpirySchedulerService,
    CreateOrderExecutor,
  ],
  exports: [
    OrderService,
    OrderApprovalService,
    OrderSettingsService,
    OrderToolSeederService,
    OrderStorePushService,
    CreateOrderExecutor,
  ],
})
export class OrderModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantAuthMiddleware)
      .forRoutes(OrderSettingsController, OrderController);
  }
}
