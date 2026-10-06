// Channel (CommentsModule, Gulf T8 / F23; D6, D11, D15b): comment automation
// on Facebook page posts and Instagram posts/Reels.
//
//   /webhooks/meta (WebhookModule) ─► CommentIngestService ─► ledger + queue
//   comment-automation queue ─► CommentAutomationProcessor ─► CommentAutomationService
//       rules prefilter ─► CommentIntentClassifier ─► CommentReplyAgent (AgentRuntime)
//       ─► CommentActionExecutor (MetaGraphClient, claims before calls)
//   DM from the commenter (WebhookModule) ─► CommentThreadService (D15b)
//   /comment-automation (console) ─► CommentRulesController
//
// Dependency direction: WebhookModule imports this module (for the ingest
// branch and the D15b hook); this module never imports WebhookModule, so the
// graph stays acyclic. Meta access goes through MetaChannelModule (page
// tokens, account resolution) and MetaGraphModule (the one Graph client).
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AgentModule } from '../agent/agent.module';
import { AgentConfigModule } from '../agent-config/agent-config.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { ConversationModule } from '../conversation/conversation.module';
import { CoreModule } from '../core';
import { CustomerModule } from '../customer/customer.module';
import { LlmModule } from '../llm/llm.module';
import { MetaChannelModule } from '../meta-channel/meta-channel.module';
import { MetaGraphModule } from '../meta-graph/meta-graph.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { QueueModule } from '../queue/queue.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { CommentActionExecutor } from './comment-action.executor';
import { COMMENT_AUTOMATION_QUEUE } from './comment-automation.queue';
import { CommentAutomationProcessor } from './comment-automation.processor';
import { CommentAutomationService } from './comment-automation.service';
import { CommentIngestService } from './comment-ingest.service';
import { CommentIntentClassifier } from './comment-intent.classifier';
import { CommentLedgerService } from './comment-ledger.service';
import { CommentRateLimiter } from './comment-rate-limiter.service';
import { CommentReplyAgent } from './comment-reply-agent.service';
import { CommentRulesController } from './comment-rules.controller';
import { CommentRulesService } from './comment-rules.service';
import { CommentThreadService } from './comment-thread.service';

export { CommentIngestService } from './comment-ingest.service';
export { CommentThreadService } from './comment-thread.service';

@Module({
  imports: [
    CoreModule,
    AuthModule,
    TenantContextModule,
    QueueModule,
    LlmModule,
    AgentModule,
    AgentConfigModule,
    OnboardingModule,
    TelemetryModule,
    BillingModule,
    CustomerModule,
    ConversationModule,
    MetaGraphModule,
    MetaChannelModule,
    BullModule.registerQueue({
      name: COMMENT_AUTOMATION_QUEUE,
      defaultJobOptions: {
        // Transient failures (model or database hiccups) retry with backoff.
        // Deferrals (tenant busy, IG limiter) do not spend attempts.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [CommentRulesController],
  providers: [
    CommentLedgerService,
    CommentRulesService,
    CommentRateLimiter,
    CommentIntentClassifier,
    CommentReplyAgent,
    CommentActionExecutor,
    CommentAutomationService,
    CommentAutomationProcessor,
    CommentIngestService,
    CommentThreadService,
  ],
  exports: [CommentIngestService, CommentThreadService],
})
export class CommentsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(CommentRulesController);
  }
}
