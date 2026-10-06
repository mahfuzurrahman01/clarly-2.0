import type Redis from 'ioredis';
import {
  COMMENT_CLASSIFY_HOURLY_LIMIT,
  COMMENT_TENANT_CONCURRENCY,
  CommentRateLimiter,
  PRIVATE_REPLY_HOURLY_LIMITS,
} from './comment-rate-limiter.service';

/** Just enough of ioredis for fixed-window counters. */
function fakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    incr: jest.fn((key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    }),
    decr: jest.fn((key: string) => {
      const next = (store.get(key) ?? 0) - 1;
      store.set(key, next);
      return Promise.resolve(next);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, Number(value));
      return Promise.resolve('OK');
    }),
  };
}

describe('CommentRateLimiter', () => {
  const now = new Date('2026-09-19T10:15:00Z');
  let redis: ReturnType<typeof fakeRedis>;
  let limiter: CommentRateLimiter;

  beforeEach(() => {
    redis = fakeRedis();
    limiter = new CommentRateLimiter(redis as unknown as Redis);
  });

  it('caps in-flight comments per tenant and frees the slot on release', async () => {
    for (let i = 0; i < COMMENT_TENANT_CONCURRENCY; i++) {
      await expect(limiter.acquireTenantSlot('t1')).resolves.toBe(true);
    }
    await expect(limiter.acquireTenantSlot('t1')).resolves.toBe(false);
    // Another tenant is unaffected.
    await expect(limiter.acquireTenantSlot('t2')).resolves.toBe(true);

    await limiter.releaseTenantSlot('t1');
    await expect(limiter.acquireTenantSlot('t1')).resolves.toBe(true);
  });

  it('never leaves a negative in-flight count behind', async () => {
    await limiter.releaseTenantSlot('t1');
    expect(redis.store.get('comments:inflight:t1')).toBe(0);
  });

  it('enforces the per-post hourly cap and reports when the window reopens', async () => {
    await expect(limiter.postReply('t1', 'p1', 2, now)).resolves.toEqual({
      allowed: true,
    });
    await limiter.postReply('t1', 'p1', 2, now);
    await expect(limiter.postReply('t1', 'p1', 2, now)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 45 * 60 * 1000,
    });
    // Other posts have their own window.
    await expect(limiter.postReply('t1', 'p2', 2, now)).resolves.toEqual({
      allowed: true,
    });
  });

  it('starts a fresh window the next hour', async () => {
    await limiter.tenantReply('t1', 1, now);
    await expect(limiter.tenantReply('t1', 1, now)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(
      limiter.tenantReply('t1', 1, new Date('2026-09-19T11:00:00Z')),
    ).resolves.toEqual({ allowed: true });
  });

  it('limits Instagram private replies per account (D11) and not Facebook ones', async () => {
    const limit = PRIVATE_REPLY_HOURLY_LIMITS.instagram as number;
    expect(limit).toBeLessThanOrEqual(750);
    redis.store.set(
      `comments:private-reply:instagram:ig-1:${Math.floor(now.getTime() / 3_600_000)}`,
      limit,
    );
    await expect(
      limiter.privateReply('instagram', 'ig-1', now),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      limiter.privateReply('instagram', 'ig-2', now),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.privateReply('messenger', 'page-1', now),
    ).resolves.toEqual({ allowed: true });
    expect(redis.incr).not.toHaveBeenCalledWith(
      expect.stringContaining('messenger'),
    );
  });

  it('guards classifier spend with a platform hourly cap', async () => {
    redis.store.set(
      `comments:classify:t1:${Math.floor(now.getTime() / 3_600_000)}`,
      COMMENT_CLASSIFY_HOURLY_LIMIT,
    );
    await expect(limiter.classify('t1', now)).resolves.toMatchObject({
      allowed: false,
    });
  });
});
