import { DelayedError, type Job } from 'bullmq';
import type { AppLoggerService } from '../core';
import {
  CommentAutomationProcessor,
  TENANT_BUSY_DELAY_MS,
} from './comment-automation.processor';
import type { CommentAutomationJobData } from './comment-automation.queue';
import type { CommentAutomationService } from './comment-automation.service';
import type { CommentLedgerService } from './comment-ledger.service';
import type { CommentRateLimiter } from './comment-rate-limiter.service';
import { CommentDeferredError } from './comment.errors';

const DATA = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  commentEventId: '33333333-3333-4333-8333-333333333333',
};

function job(overrides: Partial<Job<CommentAutomationJobData>> = {}) {
  return {
    id: 'comment-x',
    data: DATA,
    opts: { attempts: 3 },
    attemptsMade: 0,
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Job<CommentAutomationJobData> & { moveToDelayed: jest.Mock };
}

describe('CommentAutomationProcessor', () => {
  let handle: jest.Mock;
  let limiter: { acquireTenantSlot: jest.Mock; releaseTenantSlot: jest.Mock };
  let skip: jest.Mock;
  let processor: CommentAutomationProcessor;

  beforeEach(() => {
    handle = jest.fn().mockResolvedValue(undefined);
    limiter = {
      acquireTenantSlot: jest.fn().mockResolvedValue(true),
      releaseTenantSlot: jest.fn().mockResolvedValue(undefined),
    };
    skip = jest.fn().mockResolvedValue(undefined);
    processor = new CommentAutomationProcessor(
      { handle } as unknown as CommentAutomationService,
      limiter as unknown as CommentRateLimiter,
      { skip } as unknown as CommentLedgerService,
      { log: jest.fn(), error: jest.fn() } as unknown as AppLoggerService,
    );
  });

  it('handles the comment inside a tenant slot and always frees it', async () => {
    await processor.process(job(), 'tok');
    expect(handle).toHaveBeenCalledWith(DATA.tenantId, DATA.commentEventId);
    expect(limiter.releaseTenantSlot).toHaveBeenCalledWith(DATA.tenantId);

    handle.mockRejectedValueOnce(new Error('db down'));
    await expect(processor.process(job(), 'tok')).rejects.toThrow('db down');
    expect(limiter.releaseTenantSlot).toHaveBeenCalledTimes(2);
  });

  it('delays (not fails) a job whose tenant is at its concurrency limit', async () => {
    limiter.acquireTenantSlot.mockResolvedValue(false);
    const busy = job();
    const before = Date.now();

    await expect(processor.process(busy, 'tok')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(handle).not.toHaveBeenCalled();
    expect(limiter.releaseTenantSlot).not.toHaveBeenCalled();
    const [timestamp, token] = busy.moveToDelayed.mock.calls[0] as [
      number,
      string,
    ];
    expect(token).toBe('tok');
    expect(timestamp).toBeGreaterThanOrEqual(before + TENANT_BUSY_DELAY_MS);
  });

  it('delays a job the pipeline deferred (IG private-reply limit): delayed, never dropped', async () => {
    handle.mockRejectedValueOnce(new CommentDeferredError(600_000, 'ig limit'));
    const deferred = job();
    const before = Date.now();

    await expect(processor.process(deferred, 'tok')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(
      (deferred.moveToDelayed.mock.calls[0] as [number])[0],
    ).toBeGreaterThanOrEqual(before + 600_000);
    expect(limiter.releaseTenantSlot).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed job', async () => {
    await expect(
      processor.process(job({ data: { tenantId: 'x' } as never }), 'tok'),
    ).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
  });

  it('marks the comment job_failed only once retries are exhausted', async () => {
    await processor.onFailed(job({ attemptsMade: 1 }), new Error('boom'));
    expect(skip).not.toHaveBeenCalled();

    await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));
    expect(skip).toHaveBeenCalledWith(
      DATA.tenantId,
      DATA.commentEventId,
      'job_failed',
    );
  });
});
