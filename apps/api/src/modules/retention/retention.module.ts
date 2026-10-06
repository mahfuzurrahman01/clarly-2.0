import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TranscriptPurgeProcessor } from './transcript-purge.processor';
import { TRANSCRIPT_PURGE_QUEUE } from './transcript-purge.queue';
import { TranscriptPurgeSchedulerService } from './transcript-purge-scheduler.service';
import { TranscriptPurgeService } from './transcript-purge.service';

export * from './transcript-purge.dto';
export { TranscriptPurgeService } from './transcript-purge.service';

// Product shell (Feature 7, T16): "Implements the retention policy...
// (90-day transcript purge, 30-day hard-delete SLA)."
//
// THIS PASS: the scheduled 90-day transcript purge only
// (`TranscriptPurgeService`, a BullMQ repeatable job via
// `PURGE_CHECK_INTERVAL_MS`, default daily). Scoped to `conversations`
// (cascades to `messages`) — `tickets`/`agent_runs` survive with their
// `conversationId` cleared (`onDelete: 'set null'`), `conversation_outcomes`
// is untouched entirely (no FK at all, Feature 7 Slice 3) — this is T12's
// survival guarantee actually being exercised for real, not just
// simulated in a test. Per-tenant hard-delete-on-request and full tenant
// offboarding are separate, not-yet-built T16 slices.
@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    QueueModule,
    // F13: the purge deletes attachment bytes as well as message rows — no
    // foreign key reaches object storage, so nothing else would.
    StorageModule,
    BullModule.registerQueue({
      name: TRANSCRIPT_PURGE_QUEUE,
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
    TranscriptPurgeService,
    TranscriptPurgeProcessor,
    TranscriptPurgeSchedulerService,
  ],
  exports: [TranscriptPurgeService],
})
export class RetentionModule {}
