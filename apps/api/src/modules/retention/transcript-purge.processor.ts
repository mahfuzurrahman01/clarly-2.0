// RetentionModule (Feature 7, T16): worker half of the repeatable purge.
// Unlike the alert/close sweeps, a failed purge is worth a louder signal
// (log level `warn`, not silently deferred to "next cycle") — a purge
// that keeps failing means a tenant's data is staying past its retention
// commitment, a compliance-adjacent concern, not just a stale metric.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { TranscriptPurgeService } from './transcript-purge.service';
import { TRANSCRIPT_PURGE_QUEUE } from './transcript-purge.queue';

@Processor(TRANSCRIPT_PURGE_QUEUE)
export class TranscriptPurgeProcessor extends WorkerHost {
  constructor(
    private readonly transcriptPurge: TranscriptPurgeService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const results = await this.transcriptPurge.purgeAllTenants();
    if (results.length > 0) {
      const totalConversations = results.reduce(
        (sum, r) => sum + r.conversationsPurged,
        0,
      );
      const totalMessages = results.reduce(
        (sum, r) => sum + r.messagesPurged,
        0,
      );
      this.logger.log(
        `Transcript purge removed ${totalConversations} conversation(s) / ${totalMessages} message(s) across ${results.length} tenant(s)`,
        'TranscriptPurgeProcessor',
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.warn(
      `Transcript purge job ${job?.id ?? '(unknown)'} failed: ${error.message} — retention commitment at risk until the next successful run`,
      'TranscriptPurgeProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `Transcript-purge worker connection error: ${error.message}`,
      error.stack,
      'TranscriptPurgeProcessor',
    );
  }
}
