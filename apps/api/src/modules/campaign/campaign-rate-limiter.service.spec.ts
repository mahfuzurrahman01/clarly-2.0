import type Redis from 'ioredis';
import type { AppConfigService } from '../core';
import {
  CAMPAIGN_CONCURRENCY_PER_NUMBER,
  CampaignRateLimiter,
  campaignDailyAllowance,
  tierAllowance,
} from './campaign-rate-limiter.service';

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

function fakeConfig(overrides: Partial<AppConfigService> = {}) {
  return {
    campaignTierHeadroomPct: 90,
    campaignSendRatePerSecond: 2,
    ...overrides,
  } as unknown as AppConfigService;
}

describe('tierAllowance / campaignDailyAllowance (F19 D3)', () => {
  it('maps every documented tier', () => {
    expect(tierAllowance('TIER_50')).toBe(50);
    expect(tierAllowance('TIER_250')).toBe(250);
    expect(tierAllowance('TIER_2K')).toBe(2000);
    expect(tierAllowance('TIER_10K')).toBe(10_000);
    expect(tierAllowance('TIER_100K')).toBe(100_000);
    expect(tierAllowance('TIER_UNLIMITED')).toBeNull();
  });

  it('treats null, TIER_NOT_SET and an unrecognised tier as UNKNOWN, never unlimited', () => {
    expect(tierAllowance(null)).toBeUndefined();
    expect(tierAllowance(undefined)).toBeUndefined();
    expect(tierAllowance('TIER_NOT_SET')).toBeUndefined();
    expect(tierAllowance('TIER_FROM_THE_FUTURE')).toBeUndefined();
  });

  it('applies the headroom percentage', () => {
    expect(campaignDailyAllowance('TIER_2K', 'GREEN', 90)).toBe(1800);
    expect(campaignDailyAllowance('TIER_50', 'GREEN', 90)).toBe(45);
    expect(campaignDailyAllowance('TIER_100K', 'GREEN', 90)).toBe(90_000);
  });

  it('halves the allowance on a YELLOW quality rating', () => {
    expect(campaignDailyAllowance('TIER_2K', 'YELLOW', 90)).toBe(900);
    expect(campaignDailyAllowance('TIER_50', 'YELLOW', 90)).toBe(22);
  });

  it('leaves TIER_UNLIMITED uncapped even on YELLOW', () => {
    expect(campaignDailyAllowance('TIER_UNLIMITED', 'YELLOW', 90)).toBeNull();
  });
});

describe('CampaignRateLimiter', () => {
  const now = new Date('2026-09-21T10:15:30.000Z');
  let redis: ReturnType<typeof fakeRedis>;
  let limiter: CampaignRateLimiter;

  beforeEach(() => {
    redis = fakeRedis();
    limiter = new CampaignRateLimiter(redis as unknown as Redis, fakeConfig());
  });

  it('allows exactly the allowance and refuses the one after it', async () => {
    // TIER_50 at 90% headroom = 45.
    for (let i = 0; i < 45; i += 1) {
      await expect(
        limiter.dailyConversation('pn1', 'TIER_50', 'GREEN', now),
      ).resolves.toEqual({ allowed: true });
    }
    const refused = await limiter.dailyConversation(
      'pn1',
      'TIER_50',
      'GREEN',
      now,
    );
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error('expected a refusal');
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.reason).toContain('pn1');
  });

  it('rolls over into the next 24h window', async () => {
    for (let i = 0; i < 46; i += 1) {
      await limiter.dailyConversation('pn1', 'TIER_50', 'GREEN', now);
    }
    const nextWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await expect(
      limiter.dailyConversation('pn1', 'TIER_50', 'GREEN', nextWindow),
    ).resolves.toEqual({ allowed: true });
  });

  it('reports the milliseconds until the next window, not a fixed backoff', async () => {
    for (let i = 0; i < 46; i += 1) {
      await limiter.dailyConversation('pn1', 'TIER_50', 'GREEN', now);
    }
    const refused = await limiter.dailyConversation(
      'pn1',
      'TIER_50',
      'GREEN',
      now,
    );
    if (refused.allowed) throw new Error('expected a refusal');
    const dayMs = 24 * 60 * 60 * 1000;
    expect(refused.retryAfterMs).toBe(
      (Math.floor(now.getTime() / dayMs) + 1) * dayMs - now.getTime(),
    );
  });

  it('isolates one number from another', async () => {
    for (let i = 0; i < 46; i += 1) {
      await limiter.dailyConversation('pn1', 'TIER_50', 'GREEN', now);
    }
    await expect(
      limiter.dailyConversation('pn2', 'TIER_50', 'GREEN', now),
    ).resolves.toEqual({ allowed: true });
  });

  it('never consumes the counter on an unknown tier — it refuses outright', async () => {
    const refused = await limiter.dailyConversation('pn1', null, 'GREEN', now);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error('expected a refusal');
    expect(refused.reason).toContain('unknown');
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('never refuses an unlimited tier', async () => {
    for (let i = 0; i < 200; i += 1) {
      await expect(
        limiter.dailyConversation('pn1', 'TIER_UNLIMITED', 'GREEN', now),
      ).resolves.toEqual({ allowed: true });
    }
  });

  it('caps throughput per second and retries within the same second', async () => {
    await expect(limiter.throughput('pn1', now)).resolves.toEqual({
      allowed: true,
    });
    await expect(limiter.throughput('pn1', now)).resolves.toEqual({
      allowed: true,
    });
    const refused = await limiter.throughput('pn1', now);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error('expected a refusal');
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('allows only one campaign in flight per number, and frees the slot on release', async () => {
    for (let i = 0; i < CAMPAIGN_CONCURRENCY_PER_NUMBER; i += 1) {
      await expect(limiter.acquireNumberSlot('pn1')).resolves.toBe(true);
    }
    await expect(limiter.acquireNumberSlot('pn1')).resolves.toBe(false);
    // A different number is unaffected.
    await expect(limiter.acquireNumberSlot('pn2')).resolves.toBe(true);

    await limiter.releaseNumberSlot('pn1');
    await expect(limiter.acquireNumberSlot('pn1')).resolves.toBe(true);
  });

  it('never leaves a negative in-flight count behind', async () => {
    await limiter.releaseNumberSlot('pn1');
    expect(redis.store.get('campaign:inflight:pn1')).toBe(0);
    await expect(limiter.acquireNumberSlot('pn1')).resolves.toBe(true);
  });
});
