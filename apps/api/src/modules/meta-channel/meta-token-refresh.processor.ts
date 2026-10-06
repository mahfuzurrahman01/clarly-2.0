// Channel (MetaChannelModule, Feature 16): the token-refresh sweep worker.
//
// Behaviour 2 of MetaTokenService's three (see that file's header): the
// send path already keeps BUSY channels alive by refreshing before use, so
// this exists for the quiet ones. A tenant whose Instagram gets no DMs for
// the last week of its token's life would otherwise have it expire
// un-noticed and greet their next customer with a failure.
//
// Never throws out of `process()`. A sweep is a best-effort maintenance
// pass; letting one channel's failure fail the JOB would make BullMQ retry
// the whole batch and re-attempt every channel that already succeeded.
// MetaTokenService.refreshExpiringChannels() already collects per-channel
// outcomes, and they are logged here.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { AppLoggerService } from '../core';
import { MetaTokenService } from './meta-token.service';
import { META_TOKEN_REFRESH_QUEUE } from './meta-token-refresh.queue';

@Processor(META_TOKEN_REFRESH_QUEUE)
export class MetaTokenRefreshProcessor extends WorkerHost {
  constructor(
    private readonly tokens: MetaTokenService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const outcomes = await this.tokens.refreshExpiringChannels(new Date());
    if (outcomes.length === 0) return;

    const refreshed = outcomes.filter((o) => o.status === 'refreshed').length;
    const degraded = outcomes.filter(
      (o) => o.status === 'reconnect_required',
    ).length;
    const deferred = outcomes.filter((o) => o.status === 'deferred').length;

    this.logger.log(
      `meta token refresh sweep: ${outcomes.length} due, ${refreshed} refreshed, ${deferred} deferred, ${degraded} needing reconnect`,
      MetaTokenRefreshProcessor.name,
    );
  }

  // Without this a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq attaches no default listener —
  // which takes the whole process down rather than degrading one queue.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `meta-token-refresh worker connection error: ${error.message}`,
      error.stack,
      MetaTokenRefreshProcessor.name,
    );
  }
}
