import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { WhatsappNumberDirectory } from './whatsapp-number-directory.service';
import { Module } from '@nestjs/common';
import { AppConfigService, CoreModule } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { MetaGraphModule } from '../meta-graph/meta-graph.module';
import { BspCredentialsEncryptionService } from './bsp-credentials-encryption.service';
import { BspCredentialsService } from './bsp-credentials.service';
import { MetaCloudAdapter } from './meta-cloud.adapter';
import { NoopBspAdapter } from './noop-bsp.adapter';
import { BspAdapter } from './ports/bsp-adapter.port';
import { WabaHealthWebhookService } from './health/waba-health-webhook.service';
import { WhatsappNumberHealthStore } from './health/whatsapp-number-health.store';

export * from './ports/bsp-adapter.port';
export * from './customer-service-window';
export { WhatsappNumberDirectory } from './whatsapp-number-directory.service';
export * from './bsp-credentials.service';
export * from './noop-bsp.adapter';
export * from './bsp-credentials-encryption.service';
export * from './health/connection-state.policy';
export {
  WhatsappNumberHealthStore,
  type AffectedWhatsappNumber,
} from './health/whatsapp-number-health.store';
export { WabaHealthWebhookService } from './health/waba-health-webhook.service';

// Channel: BspAdapter port, send/window-check/media detection (T0/T3).
//
// Runtime-selected binding, same factory shape as OnboardingModule's
// provisioning port. Since D14 (Gulf T2, 360dialog removed) there is one
// real adapter: 'meta' (Meta Cloud API direct, MetaCloudAdapter). 'none'
// (default) binds a fail-closed no-op so the app still boots with no Meta
// app configured; production refuses 'none' at startup (env.schema.ts).
//
// Callers (WebhookIngestService, RespondPathProcessor, queue payloads)
// depend only on the port, so the provider switch needed no changes there.
@Module({
  // TenantContextModule: WhatsappNumberDirectory reads a tenant's own
  // numbers through withTenantTx like every other tenant-scoped read.
  // MetaGraphModule (Gulf T1, D8): MetaCloudAdapter's Graph I/O.
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    MetaGraphModule,
  ],
  controllers: [],
  providers: [
    WhatsappNumberDirectory,
    BspCredentialsEncryptionService,
    BspCredentialsService,
    MetaCloudAdapter,
    NoopBspAdapter,
    // Gulf T5 (D5): every connection-state / health writer goes through
    // this store; the reconcile sweep itself lives in WhatsappHealthModule.
    WhatsappNumberHealthStore,
    WabaHealthWebhookService,
    {
      provide: BspAdapter,
      useFactory: (
        config: AppConfigService,
        meta: MetaCloudAdapter,
        noop: NoopBspAdapter,
      ) => (config.bspProvider === 'meta' ? meta : noop),
      inject: [AppConfigService, MetaCloudAdapter, NoopBspAdapter],
    },
  ],
  exports: [
    BspCredentialsEncryptionService,
    BspCredentialsService,
    BspAdapter,
    WhatsappNumberDirectory,
    WhatsappNumberHealthStore,
    WabaHealthWebhookService,
  ],
})
export class WhatsappModule {}
