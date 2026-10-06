// Channel (Feature 16): Facebook Messenger + Instagram DM.
//
// The Meta sibling of `WhatsappModule`, and structured the same way:
// resolution (account id -> tenant, before any tenant context exists),
// encrypted per-tenant credentials, and one adapter per binding behind a
// shared port. What it adds beyond WhatsApp's shape is the token lifecycle
// (`MetaTokenService` + its repeatable sweep) — a Meta page token expires
// (unlike a WhatsApp system-user token), and Feature 16's own exit criterion is
// that an expiring one degrades visibly instead of silently.
//
// Module-boundary notes (AI_PIPELINE_PLAN.md's four rules):
//   - Imports WhatsappModule for exactly ONE thing:
//     `BspCredentialsEncryptionService`. That class's name says "BSP"
//     because it predates this feature; what it is, is the platform's
//     per-tenant channel-credential cipher. Standing up a second AES-GCM
//     implementation would mean two crypto paths to audit and two keys to
//     rotate, for no benefit.
//   - Raw DB access stays inside PersistenceModule/TenantContextModule —
//     everything here goes through `PersistenceService.runAdminQuery`,
//     for the reason `social_channels` has no RLS (see the table file).
//   - Does NOT import ChannelModule. The registry composes over this module,
//     not the other way round, which is what keeps the graph acyclic; the
//     adapters here extend the port by file path, needing no DI edge.
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService, CoreModule } from '../core';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MetaGraphModule } from '../meta-graph/meta-graph.module';
import { ChannelAdapter } from '../channel/ports/channel-adapter.port';
import {
  InstagramChannelAdapter,
  MessengerChannelAdapter,
} from './meta-channel.adapter';
import { MetaChannelController } from './meta-channel.controller';
import { MetaConnectHandshakeStore } from './meta-connect-handshake.store';
import { MetaConnectService } from './meta-connect.service';
import { MetaTokenService } from './meta-token.service';
import { MetaTokenRefreshProcessor } from './meta-token-refresh.processor';
import { META_TOKEN_REFRESH_QUEUE } from './meta-token-refresh.queue';
import { MetaTokenRefreshSchedulerService } from './meta-token-refresh-scheduler.service';
import { SocialChannelCredentialsService } from './social-channel-credentials.service';
import { SocialChannelDirectory } from './social-channel-directory.service';
import { SocialChannelResolutionService } from './social-channel-resolution.service';
import { SocialMediaFetcher } from './social-media.fetcher';

export * from './social-channel.errors';
export { SocialChannelResolutionService } from './social-channel-resolution.service';
export { MetaTokenService } from './meta-token.service';
export { hashMetaUserId } from '../meta-graph/meta-user-id-hash';
export type { AffectedSocialChannel } from './social-channel-credentials.service';
export {
  InstagramChannelAdapter,
  MessengerChannelAdapter,
} from './meta-channel.adapter';

/** DI token for "the Meta social bindings, if this deployment has any". Consumed by ChannelModule's CHANNEL_ADAPTERS factory. */
export const META_CHANNEL_ADAPTERS = Symbol('META_CHANNEL_ADAPTERS');

@Module({
  imports: [
    CoreModule,
    AuthModule,
    PersistenceModule,
    // TenantAuthMiddleware's dependency (Gulf T4). Not used for queries here:
    // social_channels has no RLS, see the boundary note above.
    TenantContextModule,
    QueueModule,
    // Gulf T1 (D8): the Graph client is shared with WhatsApp, no longer
    // provided here.
    MetaGraphModule,
    WhatsappModule,
    BullModule.registerQueue({
      name: META_TOKEN_REFRESH_QUEUE,
      defaultJobOptions: {
        // A missed sweep is recoverable — the next one is a day away and the
        // refresh window is a week wide — so this retries modestly rather
        // than aggressively.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [MetaChannelController],
  providers: [
    SocialChannelResolutionService,
    SocialChannelCredentialsService,
    SocialChannelDirectory,
    MetaConnectHandshakeStore,
    MetaConnectService,
    MetaTokenService,
    // Gulf T6 (D9): the allowlisted, credential-free CDN fetch.
    SocialMediaFetcher,
    MessengerChannelAdapter,
    InstagramChannelAdapter,
    MetaTokenRefreshProcessor,
    MetaTokenRefreshSchedulerService,
    {
      // An empty array when META_SOCIAL_CHANNELS_ENABLED=false, so a
      // deployment without Meta approval registers NO social binding at all
      // — `ChannelRegistry.for('messenger')` then throws
      // UnsupportedChannelError rather than half-working against an
      // unconfigured app. The controller and the schema still exist, so the
      // switch is genuinely a switch and not a code path that rots.
      provide: META_CHANNEL_ADAPTERS,
      useFactory: (
        config: AppConfigService,
        messenger: MessengerChannelAdapter,
        instagram: InstagramChannelAdapter,
      ): ChannelAdapter[] =>
        config.metaSocialChannelsEnabled ? [messenger, instagram] : [],
      inject: [
        AppConfigService,
        MessengerChannelAdapter,
        InstagramChannelAdapter,
      ],
    },
  ],
  exports: [
    META_CHANNEL_ADAPTERS,
    SocialChannelResolutionService,
    SocialChannelCredentialsService,
    SocialChannelDirectory,
    MetaTokenService,
  ],
})
export class MetaChannelModule implements NestModule {
  /**
   * Gulf T4: the console routes were registered without TenantAuthMiddleware,
   * so `req.auth` was never populated and RolesGuard (fail-closed) refused
   * every `/channels/meta` request with 403. Same wiring as every other
   * tenant-facing controller.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(MetaChannelController);
  }
}
