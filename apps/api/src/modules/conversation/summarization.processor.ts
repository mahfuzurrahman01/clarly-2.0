// Product shell (ConversationModule, A7/D7): the worker half of "runs
// async after reply, never on the respond path." Unlike every other
// placeholder processor shipped so far in this codebase (KbIngestProcessor,
// RespondPathProcessor before their real pipelines landed), this one does
// real work from day one — its dependencies (LlmProvider, ConversationService)
// already exist (Feature 3).
//
// A failed summarization job does NOT create a ticket the way
// RespondPathProcessor's exhausted jobs do — summarization failing never
// affects whether the customer got a reply (that already happened,
// synchronously, before this job was even enqueued); worst case the
// summary is simply stale until the next trigger fires. Logging and moving
// on is the correct behavior, not escalating.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { SummarizationService } from './summarization.service';
import type { SummarizeJobData } from './summarize-job.dto';
import { SUMMARIZE_QUEUE } from './summarize.queue';

@Processor(SUMMARIZE_QUEUE)
export class SummarizationProcessor extends WorkerHost {
  constructor(
    private readonly summarization: SummarizationService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<SummarizeJobData>): Promise<void> {
    await this.summarization.summarize(
      job.data.tenantId,
      job.data.conversationId,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SummarizeJobData> | undefined, error: Error): void {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= maxAttempts;

    this.logger.warn(
      `conversation-summarize job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}${
        exhausted
          ? ' — attempts exhausted, summary stays stale until the next trigger'
          : ''
      }`,
      'SummarizationProcessor',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `conversation-summarize worker connection error: ${error.message}`,
      error.stack,
      'SummarizationProcessor',
    );
  }
}
