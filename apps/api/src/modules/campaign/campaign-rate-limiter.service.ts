// F19 (D3): the campaign sender's Redis counters.
//
// Same fixed-window technique as CommentRateLimiter (INCR + EXPIRE on first
// hit — one round trip, bounded, per-key isolation), and the same rule about
// what "over the limit" means: DEFER, NEVER DROP. Every method that can
// refuse returns a `retryAfterMs`, and the processor turns that into a
// delayed job that does not spend a BullMQ attempt.
//
// Every key is the PHONE NUMBER, not the tenant, because Meta's messaging
// limits are per number: a tenant with two numbers on two WABAs has two
// independent allowances, and a tenant-keyed counter would be wrong in both
// directions at once.
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppConfigService } from '../core';
import { QUEUE_REDIS_CONNECTION } from '../queue/queue.providers';

const DAY_MS = 24 * 60 * 60 * 1000;
const SECOND_MS = 1000;

/** Safety TTL on the per-number semaphore, so a worker that died holding it cannot wedge a number forever. */
const CAMPAIGN_SLOT_TTL_SECONDS = 600;

/** Campaigns in flight per phone number (D3). Two concurrent campaigns on one number would jointly blow the tier. */
export const CAMPAIGN_CONCURRENCY_PER_NUMBER = 1;

/**
 * Meta's 24h business-initiated conversation allowance per tier.
 * `null` = unlimited (never refused); `undefined` from a lookup = unknown,
 * which D4 treats as BLOCKED rather than unlimited.
 */
export const TIER_ALLOWANCES: Readonly<Record<string, number | null>> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: null,
};

export type CampaignWindowResult =
  { allowed: true } | { allowed: false; retryAfterMs: number; reason: string };

/**
 * The raw tier allowance for a Meta tier string.
 * `undefined` means "we do not know this tier" — never treat that as
 * unlimited. `null` means genuinely unlimited (TIER_UNLIMITED).
 */
export function tierAllowance(
  tier: string | null | undefined,
): number | null | undefined {
  if (tier == null || tier === 'TIER_NOT_SET') return undefined;
  return TIER_ALLOWANCES[tier];
}

/**
 * How many messages a CAMPAIGN may send on this number in one 24h window:
 * the tier allowance minus headroom, halved on a YELLOW quality rating
 * (a YELLOW number is one bad campaign away from RED).
 *
 * `null` = uncapped. `undefined` = unknown tier, which callers must refuse.
 */
export function campaignDailyAllowance(
  tier: string | null | undefined,
  qualityRating: string | null | undefined,
  headroomPct: number,
): number | null | undefined {
  const allowance = tierAllowance(tier);
  if (allowance === undefined) return undefined;
  if (allowance === null) return null;
  const withHeadroom = Math.floor((allowance * headroomPct) / 100);
  return qualityRating === 'YELLOW'
    ? Math.floor(withHeadroom / 2)
    : withHeadroom;
}

@Injectable()
export class CampaignRateLimiter {
  constructor(
    @Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  /**
   * D3's 24h business-initiated conversation limit. Refusing returns the
   * milliseconds until the NEXT window opens — a campaign is allowed to span
   * windows (up to CAMPAIGN_MAX_WINDOW_SPAN, enforced at schedule time).
   */
  async dailyConversation(
    phoneNumberId: string,
    tier: string | null | undefined,
    qualityRating: string | null | undefined,
    now: Date,
  ): Promise<CampaignWindowResult> {
    const limit = campaignDailyAllowance(
      tier,
      qualityRating,
      this.config.campaignTierHeadroomPct,
    );
    if (limit === undefined) {
      // Fails closed, matching D4: an unknown tier is not an excuse to send.
      // Deferred rather than failed so the campaign survives a health read
      // that has not landed yet.
      return {
        allowed: false,
        retryAfterMs: nextWindowMs(now, DAY_MS),
        reason: `messaging tier for number ${phoneNumberId} is unknown`,
      };
    }
    if (limit === null) return { allowed: true };

    return this.hit(
      `campaign:daily:${phoneNumberId}`,
      limit,
      now,
      DAY_MS,
      2 * 24 * 60 * 60,
      `24h messaging limit for number ${phoneNumberId} reached`,
    );
  }

  /** D3's per-number throughput ceiling. A one-second window, so the retry is sub-second. */
  throughput(phoneNumberId: string, now: Date): Promise<CampaignWindowResult> {
    return this.hit(
      `campaign:tps:${phoneNumberId}`,
      this.config.campaignSendRatePerSecond,
      now,
      SECOND_MS,
      10,
      `throughput limit for number ${phoneNumberId} reached`,
    );
  }

  /** D3's concurrency semaphore: one campaign in flight per phone number. */
  async acquireNumberSlot(phoneNumberId: string): Promise<boolean> {
    const key = slotKey(phoneNumberId);
    const count = await this.redis.incr(key);
    await this.redis.expire(key, CAMPAIGN_SLOT_TTL_SECONDS);
    if (count > CAMPAIGN_CONCURRENCY_PER_NUMBER) {
      await this.redis.decr(key);
      return false;
    }
    return true;
  }

  async releaseNumberSlot(phoneNumberId: string): Promise<void> {
    const key = slotKey(phoneNumberId);
    const count = await this.redis.decr(key);
    // Never leave a negative count behind: a TTL expiry between acquire and
    // release would otherwise make the next acquire read -1 + 1 = 0 and let
    // two campaigns onto one number.
    if (count < 0) {
      await this.redis.set(key, '0', 'EX', CAMPAIGN_SLOT_TTL_SECONDS);
    }
  }

  private async hit(
    prefix: string,
    limit: number,
    now: Date,
    windowMs: number,
    ttlSeconds: number,
    reason: string,
  ): Promise<CampaignWindowResult> {
    const window = Math.floor(now.getTime() / windowMs);
    const key = `${prefix}:${window}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    if (count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: nextWindowMs(now, windowMs),
      reason,
    };
  }
}

function slotKey(phoneNumberId: string): string {
  return `campaign:inflight:${phoneNumberId}`;
}

function nextWindowMs(now: Date, windowMs: number): number {
  const window = Math.floor(now.getTime() / windowMs);
  return (window + 1) * windowMs - now.getTime();
}
