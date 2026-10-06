import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AgentConfigModule } from '../agent-config/agent-config.module';
import { OutboundModule } from '../outbound/outbound.module';
import { AgentModule } from '../agent/agent.module';
import { BillingModule } from '../billing/billing.module';
import { ConversationModule } from '../conversation/conversation.module';
import { CoreModule } from '../core';
import { CustomerModule } from '../customer/customer.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TicketModule } from '../ticket/ticket.module';
import { StorageModule } from '../storage/storage.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ChannelModule } from '../channel/channel.module';
import { MetaChannelModule } from '../meta-channel/meta-channel.module';
import { CommentsModule } from '../comments/comments.module';
import { CampaignModule } from '../campaign/campaign.module';
import { MediaDownloadProcessor } from './media-download.processor';
import { MEDIA_DOWNLOAD_QUEUE } from './media-download.queue';
import { MediaIntakeService } from './media-intake.service';
import { RespondPathProcessor } from './respond-path.processor';
import { WebhookController } from './webhook.controller';
import { RespondPathProducerService } from './respond-path-producer.service';
import { WebhookDedupService } from './webhook-dedup.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookRateLimiterService } from './webhook-rate-limiter.service';
import { WebWidgetResolutionService } from './web-widget-resolution.service';
import { WhatsappNumberResolutionService } from './whatsapp-number-resolution.service';
import { ChannelTenantResolver } from './channel-tenant-resolver.service';
import { MetaWebhookController } from './meta-webhook.controller';

export * from './unknown-whatsapp-number.error';
export * from './channel-tenant-resolver.service';
export * from './webhook-ingest.service';
export * from './respond-path-job.dto';
export * from './media-download.queue';

// Channel: signature verify, idempotency dedup, enqueue only (T6). No
// dependency-rule constraints apply, but must stay ACK-fast (T11) — no
// inline agent-run work here.
//
// THIS PASS (Feature 4): the full BSP-agnostic pipeline (T6 tenant
// resolution + dedup, T17 rate limiting, T3 unsupported-media escalation,
// T11 enqueue + retry/backoff + terminal-ticket-on-exhaustion) is real and
// tested — see docs/decisions/F2-channel.md. RespondPathProcessor now
// calls AgentModule's AgentRuntime.respond() for real (Feature 3+4
// integration) instead of always failing. No `WebhookController`/HTTP
// endpoint yet: that needs a bound `BspAdapter` implementation, which is
// the one piece gated on T0 sign-off (docs/decisions/T0-bsp-selection.md).
// UPDATE (2026-08-15, T0 signed off): `WebhookController` is
// now wired — `POST /webhooks/whatsapp`, trusting only the BSP signature,
// delegating to the same WebhookIngestService that already existed. It was
// indeed a small addition, not a redesign. WhatsappModule is imported for
// the bound `BspAdapter` the controller hands to `ingest()`.
@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    QueueModule,
    TicketModule,
    ConversationModule,
    CustomerModule,
    OnboardingModule,
    AgentModule,
    AgentConfigModule,
    OutboundModule,
    TelemetryModule,
    BillingModule,
    StorageModule,
    WhatsappModule,
    // Feature 16: ChannelModule supplies the channel->adapter registry the
    // respond path and the Meta controller resolve bindings from;
    // MetaChannelModule supplies the page/IG -> tenant resolution half of T6.
    ChannelModule,
    MetaChannelModule,
    // Gulf T8 (F23): the comment branch of `/webhooks/meta` and the D15b
    // private-reply hook on inbound DMs.
    CommentsModule,
    // F19 (D5): the campaign delivery tracker and the reply-attribution
    // hook. The dependency points THIS way only — CampaignModule never
    // imports WebhookModule, so the graph stays acyclic (same arrangement as
    // CommentsModule above).
    CampaignModule,
    BullModule.registerQueue({
      name: MEDIA_DOWNLOAD_QUEUE,
      defaultJobOptions: {
        // Fewer attempts and a shorter backoff than the outbound-webhook
        // queue: Meta's media ids expire, so retrying for minutes buys
        // nothing — either the fetch works soon or the bytes are gone and
        // the row should say so.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [WebhookController, MetaWebhookController],
  providers: [
    WhatsappNumberResolutionService,
    WebWidgetResolutionService,
    ChannelTenantResolver,
    WebhookDedupService,
    WebhookRateLimiterService,
    RespondPathProducerService,
    RespondPathProcessor,
    MediaIntakeService,
    MediaDownloadProcessor,
    WebhookIngestService,
  ],
  exports: [WebhookIngestService],
})
export class WebhookModule {}
