import { Worker, type WorkerOptions } from 'bullmq';
import {
  LEAN_WORKER_TUNING,
  LeanWorker,
  withLeanWorkerDefaults,
} from './lean-worker';

const NOW = 1_700_000_000_000;

/**
 * A LeanWorker with only the state getBlockTimeout() reads. Constructing a
 * real Worker opens a Redis connection, which a unit test must not need;
 * Object.create keeps the real prototype chain (LeanWorker -> Worker), so
 * the override AND BullMQ's own implementation it delegates to both run.
 */
function leanWorkerState(opts: Partial<WorkerOptions>): LeanWorker {
  return Object.assign(Object.create(LeanWorker.prototype) as LeanWorker, {
    opts: withLeanWorkerDefaults(opts as WorkerOptions),
    blockingConnection: {
      capabilities: { canBlockFor1Ms: true, canDoubleTimeout: true },
    },
  });
}

function blockTimeout(worker: LeanWorker, blockUntil: number): number {
  return worker['getBlockTimeout'](blockUntil);
}

describe('withLeanWorkerDefaults', () => {
  it('applies the lean idle-polling defaults', () => {
    const opts = withLeanWorkerDefaults({ connection: {} });

    expect(opts.drainDelay).toBe(LEAN_WORKER_TUNING.drainDelaySeconds);
    expect(opts.stalledInterval).toBe(LEAN_WORKER_TUNING.stalledIntervalMs);
  });

  it('keeps every option a processor set explicitly (concurrency, its own drainDelay, connection)', () => {
    const connection = { host: 'redis.local' };
    const opts = withLeanWorkerDefaults({
      connection,
      concurrency: 4,
      drainDelay: 7,
    });

    expect(opts.connection).toBe(connection);
    expect(opts.concurrency).toBe(4);
    expect(opts.drainDelay).toBe(7);
    expect(opts.stalledInterval).toBe(LEAN_WORKER_TUNING.stalledIntervalMs);
  });

  it('does not mutate the options it was given', () => {
    const input = { connection: {} } as WorkerOptions;

    withLeanWorkerDefaults(input);

    expect(input).not.toHaveProperty('drainDelay');
  });

  it('only ever lengthens idle intervals relative to BullMQ defaults (5s drain, 30s stalled)', () => {
    expect(LEAN_WORKER_TUNING.drainDelaySeconds).toBeGreaterThan(5);
    expect(LEAN_WORKER_TUNING.stalledIntervalMs).toBeGreaterThan(30_000);
    expect(LEAN_WORKER_TUNING.maxBlockTimeoutSeconds).toBeGreaterThan(10);
  });
});

describe('LeanWorker', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('is a BullMQ Worker, so @nestjs/bullmq can use it as the worker class', () => {
    expect(LeanWorker.prototype).toBeInstanceOf(Worker);
  });

  it('with no delayed job, blocks for the lean drainDelay', () => {
    expect(blockTimeout(leanWorkerState({}), 0)).toBe(
      LEAN_WORKER_TUNING.drainDelaySeconds,
    );
  });

  it('blocks until a delayed job is due instead of waking every 10s (BullMQ built-in cap)', () => {
    const dueIn120s = NOW + 120_000;

    expect(blockTimeout(leanWorkerState({}), dueIn120s)).toBe(120);
  });

  it('caps a far-future delayed job at the lean maximum block timeout', () => {
    const dueTomorrow = NOW + 86_400_000;

    expect(blockTimeout(leanWorkerState({}), dueTomorrow)).toBe(
      LEAN_WORKER_TUNING.maxBlockTimeoutSeconds,
    );
  });

  it('keeps BullMQ behaviour for a delayed job that is already due', () => {
    expect(blockTimeout(leanWorkerState({}), NOW - 5)).toBe(-5);
  });

  it('keeps BullMQ behaviour for a delayed job due within its minimum block window', () => {
    expect(blockTimeout(leanWorkerState({}), NOW + 0.5)).toBe(0.001);
  });

  it('keeps BullMQ behaviour for a delayed job due sooner than 10s', () => {
    expect(blockTimeout(leanWorkerState({}), NOW + 3_000)).toBe(3);
  });
});
