import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService } from '../core/config/app-config.service';
import { CoreModule } from '../core/core.module';
import {
  createQueueRedisClient,
  queueRedisConnectionProvider,
  QUEUE_REDIS_CONNECTION,
  RESPOND_PATH_QUEUE,
} from './queue.providers';
import { QueueHealthService } from './queue-health.service';
import { queueWorkerProfileProvider } from './queue-worker-profile.provider';

// Platform: BullMQ; webhook ACKs immediately, respond path runs in a worker
// (T6/T9). No dependency-rule constraints apply.
//
// `respond-path` (T11): webhook ACK -> enqueue -> worker. defaultJobOptions
// is the bounded retry/backoff policy T11 requires — 3 attempts,
// exponential backoff starting at 2s. `removeOnFail: false` is a
// deliberate design choice, not an oversight: instead of standing up a
// second, separate DLQ queue, a job that exhausts its attempts stays
// queryable in this queue's own failed set — that IS the de facto DLQ.
// WebhookModule's RespondPathEscalationListener (Feature 2) reacts to
// `attemptsMade` reaching the configured max and creates the terminal
// escalation ticket (T11: "never a silent drop").
//
// No `@Processor`/worker is registered here — the worker that actually
// does agent-run work belongs to AgentModule (Feature 3), which doesn't
// exist yet. WebhookModule ships a placeholder processor for this pass
// (see respond-path.processor.ts) that always fails, so every enqueued
// job correctly and visibly escalates to a human ticket until the real
// agent worker replaces it — never silently succeeds doing nothing.
@Module({
  imports: [
    CoreModule,
    BullModule.forRootAsync({
      imports: [CoreModule],
      // The client is built by createQueueRedisClient(), never by
      // decomposing the URL into host/port/password here: doing that drops
      // the database index, TLS and the username (see that function for what
      // each of those breaks).
      useFactory: (config: AppConfigService) => ({
        connection: createQueueRedisClient(config.redisUrl),
      }),
      inject: [AppConfigService],
    }),
    BullModule.registerQueue({
      name: RESPOND_PATH_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [],
  // queueWorkerProfileProvider: QUEUE_PROFILE -> the worker class every
  // @Processor gets (see that file for why this is the one global hook).
  providers: [
    queueRedisConnectionProvider,
    queueWorkerProfileProvider,
    QueueHealthService,
  ],
  exports: [QueueHealthService, BullModule, QUEUE_REDIS_CONNECTION],
})
export class QueueModule {}
