import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { registerJobSchedulerInBackground } from './register-job-scheduler';

function queueWith(upsertJobScheduler: jest.Mock): Queue {
  return { name: 'test-queue', upsertJobScheduler } as unknown as Queue;
}

describe('registerJobSchedulerInBackground', () => {
  afterEach(() => jest.restoreAllMocks());

  it('upserts the scheduler with the given id, repeat options and job template', () => {
    const upsert = jest.fn().mockResolvedValue(undefined);

    registerJobSchedulerInBackground(
      queueWith(upsert),
      'sched-id',
      { every: 60000 },
      { name: 'job-name' },
    );

    expect(upsert).toHaveBeenCalledWith(
      'sched-id',
      { every: 60000 },
      { name: 'job-name' },
    );
  });

  it('returns synchronously without waiting for Redis (a hung connection must not block app bootstrap)', () => {
    const upsert = jest.fn().mockReturnValue(new Promise(() => undefined));

    const result = registerJobSchedulerInBackground(
      queueWith(upsert),
      'sched-id',
      { every: 1 },
      { name: 'job-name' },
    );

    expect(result).toBeUndefined();
  });

  it('logs the failure with queue and scheduler id instead of throwing or leaving an unhandled rejection', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const upsert = jest
      .fn()
      .mockRejectedValue(new Error('Connection is closed.'));

    expect(() =>
      registerJobSchedulerInBackground(
        queueWith(upsert),
        'sched-id',
        { every: 1 },
        { name: 'job-name' },
      ),
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain('test-queue');
    expect(message).toContain('sched-id');
    expect(message).toContain('Connection is closed.');
  });

  it('does not throw when upsertJobScheduler throws synchronously', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const upsert = jest.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() =>
      registerJobSchedulerInBackground(
        queueWith(upsert),
        'sched-id',
        { every: 1 },
        { name: 'job-name' },
      ),
    ).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
