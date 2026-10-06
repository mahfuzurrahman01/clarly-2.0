// Platform (QueueModule): applies QUEUE_PROFILE to every @Processor worker.
//
// @nestjs/bullmq builds each worker from the @Processor() decorator's
// options plus only connection/prefix/telemetry from the queue config; there
// is no shared "default worker options" setting. Its one global hook is the
// worker CLASS (`BullModule.workerClass`, a public static setter read by
// BullExplorer when it creates workers in BullRegistrar.onModuleInit).
// Swapping that class is how lean tuning reaches all 24 processors without
// editing any of them.
//
// Ordering: Nest instantiates every (non-request-scoped) provider in the
// app before running any onModuleInit hook, so this factory always runs
// before BullExplorer creates workers.
import { BullModule } from '@nestjs/bullmq';
import type { Provider, Type } from '@nestjs/common';
import { Worker } from 'bullmq';
import { AppConfigService } from '../core/config/app-config.service';
import { AppLoggerService } from '../core/logger/app-logger.service';
import type { QueueProfile } from '../core/config/queue-profile-defaults';
import { LeanWorker } from './lean-worker';

export const QUEUE_WORKER_PROFILE = Symbol('QUEUE_WORKER_PROFILE');

export function workerClassForProfile(profile: QueueProfile): Type<Worker> {
  return profile === 'lean' ? LeanWorker : Worker;
}

export const queueWorkerProfileProvider: Provider = {
  provide: QUEUE_WORKER_PROFILE,
  useFactory: (
    config: AppConfigService,
    logger: AppLoggerService,
  ): QueueProfile => {
    // Set for 'default' too (to the stock Worker, which is also the
    // library's own default) so the outcome never depends on what an
    // earlier app instance in the same process installed.
    BullModule.workerClass = workerClassForProfile(config.queueProfile);
    logger.log(`Queue profile: ${config.queueProfile}`, 'QueueWorkerProfile');
    return config.queueProfile;
  },
  inject: [AppConfigService, AppLoggerService],
};
