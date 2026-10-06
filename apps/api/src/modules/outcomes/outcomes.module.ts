import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AutoCloseSweepProcessor } from './auto-close-sweep.processor';
import { AUTO_CLOSE_SWEEP_QUEUE } from './auto-close-sweep.queue';
import { AutoCloseSweepSchedulerService } from './auto-close-sweep-scheduler.service';
import { AutoCloseSweepService } from './auto-close-sweep.service';
import { ConversationOutcomeService } from './conversation-outcome.service';

export * from './conversation-outcome.dto';
export { ConversationOutcomeService } from './conversation-outcome.service';
export {
  AutoCloseSweepService,
  type AutoClosedConversation,
} from './auto-close-sweep.service';

// Product shell (Feature 7, A9): "conversation close resolver,
// conversation_outcomes (anonymized, permanent)." Two close paths:
// `ConversationOutcomeService.recordTicketResolved()` (called from
// TicketModule's `TicketStateService.resolve()`) and
// `AutoCloseSweepService` (a BullMQ repeatable sweep, interval via
// `AUTO_CLOSE_CHECK_INTERVAL_MS`, for conversations that never escalated
// and have gone quiet past `AUTO_CLOSE_INACTIVITY_HOURS`). MetricsModule
// (Feature 5) reads `conversation_outcomes` for its resolution-rate/
// escalation-breakdown API — that's the A9-hardening swap, not built in
// this module (MetricsService's own read-side implementation, unchanged
// public contract).
@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    QueueModule,
    BullModule.registerQueue({
      name: AUTO_CLOSE_SWEEP_QUEUE,
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
    ConversationOutcomeService,
    AutoCloseSweepService,
    AutoCloseSweepProcessor,
    AutoCloseSweepSchedulerService,
  ],
  exports: [ConversationOutcomeService, AutoCloseSweepService],
})
export class OutcomesModule {}
