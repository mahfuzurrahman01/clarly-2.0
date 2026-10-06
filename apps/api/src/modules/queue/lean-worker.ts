// Platform (QueueModule): the BullMQ worker used when QUEUE_PROFILE=lean.
//
// An idle BullMQ worker is not idle on the wire. Each one loops
//   BZPOPMIN <marker> <timeout>   (blocking, on its own connection)
//   EVALSHA moveToActive          (when the block times out)
// plus an EVALSHA stalled-jobs check every `stalledInterval`. The block
// timeout is `drainDelay` (default 5s) for an empty queue, but for a queue
// holding a DELAYED job it is min(time-until-due, 10s), and that 10s is a
// hard-coded constant in BullMQ, not an option. Every repeat-scheduled
// queue always holds its next run as a delayed job, so all 15 sweep
// workers wake every 10s regardless of their schedule. Measured locally:
// ~460 billable commands/minute for this API at rest.
//
// LeanWorker lengthens all three intervals. Correctness does not depend on
// them: adding a job (or a delayed job due earlier) writes the marker key,
// which wakes BZPOPMIN immediately, and a delayed job still fires on time
// because the block ends when it is due (bounded by the lean cap). What
// gets slower:
// - recovery of a job whose worker died mid-run: stalled detection takes
//   up to 2 x stalledIntervalMs (BullMQ marks, then moves on the next pass);
// - noticing a blocking connection that died silently (no RST): BullMQ's
//   watchdog reconnects after blockTimeout + 1s, so a job enqueued in that
//   window waits up to maxBlockTimeoutSeconds. A healthy connection is
//   unaffected.
import { Worker, type WorkerOptions } from 'bullmq';

export interface LeanWorkerTuning {
  /** Block timeout (seconds) for an empty queue. BullMQ default: 5. */
  readonly drainDelaySeconds: number;
  /** How often a worker runs the stalled-jobs check (ms). BullMQ default: 30000. */
  readonly stalledIntervalMs: number;
  /** Longest single block while a delayed job is pending (s). BullMQ: 10, fixed. */
  readonly maxBlockTimeoutSeconds: number;
}

export const LEAN_WORKER_TUNING: LeanWorkerTuning = {
  drainDelaySeconds: 300,
  stalledIntervalMs: 300_000,
  maxBlockTimeoutSeconds: 300,
};

/**
 * Lean defaults under the options @nestjs/bullmq hands the worker (the
 * shared connection/prefix plus whatever the @Processor() decorator set).
 * Anything set explicitly wins, so a processor's concurrency or its own
 * tuning is never overridden.
 */
export function withLeanWorkerDefaults(opts: WorkerOptions): WorkerOptions {
  return {
    drainDelay: LEAN_WORKER_TUNING.drainDelaySeconds,
    stalledInterval: LEAN_WORKER_TUNING.stalledIntervalMs,
    ...opts,
  };
}

type WorkerProcessor = ConstructorParameters<typeof Worker>[1];

export class LeanWorker extends Worker {
  /** Same call shape @nestjs/bullmq uses for its worker class: it always passes options. */
  constructor(name: string, processor: WorkerProcessor, opts: WorkerOptions) {
    super(name, processor, withLeanWorkerDefaults(opts));
  }

  /**
   * BullMQ caps the wait for a pending delayed job at 10s. Lift that cap to
   * LEAN_WORKER_TUNING.maxBlockTimeoutSeconds; every other case (empty
   * queue, job already due, sub-millisecond waits) keeps BullMQ's result.
   */
  protected override getBlockTimeout(blockUntil: number): number {
    const bullmqTimeout = super.getBlockTimeout(blockUntil);
    if (!blockUntil || bullmqTimeout <= 0) {
      return bullmqTimeout;
    }
    const secondsUntilDue = (blockUntil - Date.now()) / 1000;
    if (secondsUntilDue <= bullmqTimeout) {
      return bullmqTimeout;
    }
    return Math.min(secondsUntilDue, LEAN_WORKER_TUNING.maxBlockTimeoutSeconds);
  }
}
