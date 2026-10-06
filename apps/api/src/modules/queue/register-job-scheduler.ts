import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

const logger = new Logger('JobSchedulerRegistration');

type UpsertArgs = Parameters<Queue['upsertJobScheduler']>;

/**
 * Registers a repeatable BullMQ job without blocking app bootstrap.
 *
 * Every `*SchedulerService.onModuleInit()` used to `await` this call. When
 * Redis is slow or refusing connections (e.g. the free Key Value tier's
 * connection cap during a Render deploy overlap), each await stalls
 * `NestFactory.create()` and `app.listen()` is never reached before the
 * platform's deploy timeout. Fire-and-forget with an error log keeps the API
 * bootable; `upsertJobScheduler` is idempotent, so the next boot (or a
 * Redis recovery followed by restart) re-registers any schedule that failed.
 */
export function registerJobSchedulerInBackground(
  queue: Queue,
  schedulerId: UpsertArgs[0],
  repeat: UpsertArgs[1],
  jobTemplate: UpsertArgs[2],
): void {
  const reportFailure = (error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to register job scheduler "${schedulerId}" on queue "${queue.name}": ${reason}`,
    );
  };

  try {
    queue
      .upsertJobScheduler(schedulerId, repeat, jobTemplate)
      .catch(reportFailure);
  } catch (error: unknown) {
    reportFailure(error);
  }
}
