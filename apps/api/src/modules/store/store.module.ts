// Feature 24 (Store Integrations): module for store connection management.
// Provides the OAuth flow, product sync, webhook handling, and order creation.
//
// Module-boundary notes (AI_PIPELINE_PLAN.md's four rules):
//   - No raw DB access here. Tenant-scoped work goes through
//     TenantContextModule; the two genuinely pre-tenant reads (webhook
//     routing, platform sync sweep) go through PersistenceService
//     .runAdminQuery, the documented carve-out.
//   - Imports WhatsappModule for exactly one thing:
//     `BspCredentialsEncryptionService` — the platform's channel-credential
//     cipher, reused here for store OAuth tokens rather than standing up a
//     second AES-GCM path (same reasoning MetaChannelModule records).
//   - TenantAuthMiddleware is applied to StoreController ONLY. The callback
//     and webhook controllers are unauthenticated by nature (a browser
//     redirect and a provider POST); their trust comes from the signed OAuth
//     state and the webhook signature respectively.
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PersistenceModule } from '../persistence/persistence.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomerModule } from '../customer/customer.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { QueueModule } from '../queue/queue.module';
import { StoreConnectionService } from './store-connection.service';
import { StoreOAuthService } from './store-oauth.service';
import { StoreOAuthStateService } from './store-oauth-state.service';
import { StoreProviderRegistry } from './store-provider.registry';
import { StoreSyncService } from './store-sync.service';
import { StoreSyncJobService } from './store-sync-job.service';
import { StoreOrderLookupService } from './store-order-lookup.service';
import { StoreWebhookService } from './store-webhook.service';
import { StoreWebhookEventStore } from './store-webhook-event.store';
import { StoreSyncProcessor } from './store-sync.processor';
import { StoreSyncSchedulerService } from './store-sync-scheduler.service';
import { STORE_SYNC_QUEUE } from './store-sync.queue';
import { StoreController } from './store.controller';
import { StoreCallbackController } from './store-callback.controller';
import { StoreWebhookController } from './store-webhook.controller';
import { NoopStoreProvider } from './ports/noop-store.provider';
import { SallaStoreProvider } from './ports/salla-store.provider';
import { ZidStoreProvider } from './ports/zid-store.provider';
import { ShopifyStoreProvider } from './ports/shopify-store.provider';
import { WooCommerceStoreProvider } from './ports/woocommerce-store.provider';

export { StoreConnectionService } from './store-connection.service';
export { StoreOAuthService } from './store-oauth.service';
export { StoreOAuthStateService } from './store-oauth-state.service';
export { StoreSyncService } from './store-sync.service';
export { StoreSyncJobService } from './store-sync-job.service';
export { StoreOrderLookupService } from './store-order-lookup.service';
export type { ConnectedStoreOrder } from './store-order-lookup.service';
export { StoreWebhookService } from './store-webhook.service';
export type { StoreProviderName } from './store-provider-name';

@Module({
  imports: [
    PersistenceModule,
    TenantContextModule,
    AuthModule,
    BillingModule,
    // F24 catalog sync: StoreSyncService upserts the products it pulls from
    // the storefront through CatalogService. This import was missing when F25
    // landed — the app could not boot far enough to find out, because the
    // module graph itself was cyclic.
    CatalogModule,
    CustomerModule,
    WhatsappModule,
    // StoreOAuthStateService's single-use OAuth-state nonce lives in the
    // same Redis QueueModule already connects to, rather than a second
    // ad-hoc client.
    QueueModule,
    // F24 follow-up: the sync sweep used to be a raw `setInterval`, which
    // fans out once per replica (job rows duplicated per replica for the
    // same connection). `upsertJobScheduler` on this queue runs the
    // repeatable `sweep` job once platform-wide, same idiom as F26's
    // shipment-poll queue.
    BullModule.registerQueue({
      name: STORE_SYNC_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [
    StoreController,
    StoreCallbackController,
    StoreWebhookController,
  ],
  providers: [
    StoreConnectionService,
    StoreOAuthService,
    StoreOAuthStateService,
    StoreProviderRegistry,
    StoreSyncService,
    StoreSyncJobService,
    StoreOrderLookupService,
    StoreWebhookService,
    StoreWebhookEventStore,
    StoreSyncProcessor,
    StoreSyncSchedulerService,
    NoopStoreProvider,
    SallaStoreProvider,
    ZidStoreProvider,
    ShopifyStoreProvider,
    WooCommerceStoreProvider,
  ],
  exports: [
    StoreConnectionService,
    StoreOAuthService,
    // F25: OrderStorePushService resolves the storefront adapter through the
    // registry to push an approved order back. Imported by OrderModule when
    // F25 landed, but never exported here.
    StoreProviderRegistry,
    StoreSyncService,
    StoreSyncJobService,
    StoreOrderLookupService,
    StoreWebhookService,
  ],
})
export class StoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(StoreController);
  }
}
