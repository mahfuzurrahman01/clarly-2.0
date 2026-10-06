import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { LlmModule } from '../llm/llm.module';
import { ChannelModule } from '../channel/channel.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { BurstCoalescingService } from './burst-coalescing.service';
import { ConversationLockService } from './conversation-lock.service';
import { ConversationService } from './conversation.service';
import { ConversationQueryService } from './conversation-query.service';
import { IntakeService } from './intake.service';
import { SummarizationProcessor } from './summarization.processor';
import { SummarizationService } from './summarization.service';
import { SUMMARIZE_QUEUE } from './summarize.queue';

export * from './conversation-key';
export * from './coalesced-respond-job.dto';
export * from './conversation.dto';
export * from './conversation-query.dto';
export * from './inbox-cursor';
export * from './summarize-job.dto';
export { ConversationLockService } from './conversation-lock.service';
export { ConversationService } from './conversation.service';
export { ConversationQueryService } from './conversation-query.service';
export { IntakeService } from './intake.service';
export { SummarizationService } from './summarization.service';
export {
  BurstCoalescingService,
  type InboundMessage,
} from './burst-coalescing.service';

// Product shell: conversations/messages/summary/window state/lock (A7/T10). No dependency-rule constraints apply directly.
//
// THIS PASS (Feature 4, A7-proper): `ConversationService` (real
// `conversations`/`messages` read/write path) + `SummarizationService`/
// `SummarizationProcessor` (D7's async rolling summary — the trigger check
// is cheap enough to run on the respond path; the actual LLM call runs
// only in the `conversation-summarize` worker). T10's pieces
// (`ConversationLockService`/`BurstCoalescingService`) are unchanged from
// Feature 3.
@Module({
  imports: [
    CoreModule,
    TenantContextModule,
    QueueModule,
    LlmModule,
    // Feature 16: ConversationQueryService evaluates a thread's reply window
    // through ChannelPolicyRegistry rather than assuming WhatsApp's 24 hours.
    // No cycle — ChannelModule composes over Whatsapp/MetaChannel only.
    ChannelModule,
    BullModule.registerQueue({
      name: SUMMARIZE_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [],
  providers: [
    ConversationLockService,
    BurstCoalescingService,
    ConversationService,
    ConversationQueryService,
    IntakeService,
    SummarizationService,
    SummarizationProcessor,
  ],
  exports: [
    ConversationLockService,
    BurstCoalescingService,
    ConversationService,
    ConversationQueryService,
    IntakeService,
    SummarizationService,
  ],
})
export class ConversationModule {}
