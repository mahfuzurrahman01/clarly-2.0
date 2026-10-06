// F19 (D8): campaigns & broadcast.
//
//   /segments   (console) ─► SegmentService ─► SegmentCompiler ─► customers
//   /campaigns  (console) ─► CampaignService ─┬─► CampaignEligibilityService (D4)
//                                             └─► CampaignSendSchedulerService
//   campaign-send queue ─► CampaignSendProcessor ─► CampaignRunnerService
//       SegmentResolverService.snapshot()  (launch, once)
//       CampaignSenderService.sendOne()    (claim -> Graph -> account)
//       CampaignRateLimiter                (tier / throughput / semaphore)
//   /webhooks/whatsapp (WebhookModule) ─► CampaignDeliveryTracker (D5)
//
// Dependency direction (D8): WebhookModule imports this module for the
// delivery tracker and the reply hook; this module never imports
// WebhookModule, so the graph stays acyclic — the same arrangement
// CommentsModule already uses, for the same reason.
import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { ConversationModule } from '../conversation/conversation.module';
import { CoreModule } from '../core';
import { NotificationRecordModule } from '../notifications/notification-record.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TemplatesModule } from '../templates/templates.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { WhatsappHealthModule } from '../whatsapp/health/whatsapp-health.module';
import { CampaignController } from './campaign.controller';
import { CampaignDeliveryTracker } from './campaign-delivery.tracker';
import { CampaignEligibilityService } from './campaign-eligibility.service';
import { CampaignRateLimiter } from './campaign-rate-limiter.service';
import { CampaignRunnerService } from './campaign-runner.service';
import { CAMPAIGN_SEND_QUEUE } from './campaign-send.queue';
import { CampaignSendProcessor } from './campaign-send.processor';
import { CampaignSendSchedulerService } from './campaign-send.scheduler.service';
import { CampaignSenderService } from './campaign-sender.service';
import { CampaignService } from './campaign.service';
import { CampaignStatsService } from './campaign-stats.service';
import { SegmentController } from './segment.controller';
import { SegmentResolverService } from './segment-resolver.service';
import { SegmentService } from './segment.service';

export * from './segment.dto.zod';
export * from './campaign.dto.zod';
export * from './segment-definition.schema';
export { SegmentService } from './segment.service';
export { SegmentResolverService } from './segment-resolver.service';
export { CampaignService } from './campaign.service';
export { CampaignDeliveryTracker } from './campaign-delivery.tracker';
export { CampaignStatsService } from './campaign-stats.service';
export * from './segment-compiler';
export * from './marketing-opt-out-fragment';

@Module({
  imports: [
    CoreModule,
    TenantContextModule,
    AuthModule,
    BillingModule,
    TemplatesModule,
    ConversationModule,
    NotificationRecordModule,
    // The BspAdapter port the sender sends through — the same one the
    // console template send uses, never a second Graph client.
    WhatsappModule,
    // D4's on-demand health read, which is deliberately the SAME code path
    // as T5's daily reconcile.
    WhatsappHealthModule,
    // Supplies QUEUE_REDIS_CONNECTION for CampaignRateLimiter's windows.
    QueueModule,
    BullModule.registerQueue({ name: CAMPAIGN_SEND_QUEUE }),
  ],
  controllers: [SegmentController, CampaignController],
  providers: [
    SegmentService,
    SegmentResolverService,
    CampaignService,
    CampaignEligibilityService,
    CampaignRateLimiter,
    CampaignSenderService,
    CampaignSendSchedulerService,
    CampaignRunnerService,
    CampaignSendProcessor,
    CampaignStatsService,
    CampaignDeliveryTracker,
  ],
  exports: [
    SegmentService,
    SegmentResolverService,
    CampaignService,
    CampaignStatsService,
    // WebhookModule's two hooks (D5).
    CampaignDeliveryTracker,
  ],
})
export class CampaignModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantAuthMiddleware)
      .forRoutes(SegmentController, CampaignController);
  }
}
