// Gulf T8 (D11): the comment pipeline's Redis counters.
//
//   - per-tenant concurrency: a small semaphore so one tenant's viral post
//     cannot occupy every worker slot of the shared queue;
//   - per-post and per-tenant hourly reply caps (tenant-configurable), and a
//     platform cap on classifier calls per tenant per hour (spend guard);
//   - the Instagram private-reply limiter: Meta allows 750 private replies
//     per hour per IG professional account (posts and Reels). Over it the job
//     is DELAYED to the next window, never dropped.
//
// Fixed hour windows (INCR + EXPIRE on first hit), the same technique
// WebhookRateLimiterService uses: one round trip, bounded, per-key isolation.
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { QUEUE_REDIS_CONNECTION } from '../queue/queue.providers';
import type { ChannelKind } from '../channel/ports/channel-kind';

const HOUR_MS = 60 * 60 * 1000;

/** Comments one tenant may have in flight at once, across all workers. */
export const COMMENT_TENANT_CONCURRENCY = 2;
/** Safety TTL on the semaphore, so a worker that died holding a slot cannot wedge a tenant. */
const TENANT_SLOT_TTL_SECONDS = 300;

/** Platform guard on tier-2 classifier calls, independent of the tenant's reply caps. */
export const COMMENT_CLASSIFY_HOURLY_LIMIT = 1000;

/**
 * Private replies per hour per account, where the platform limits them.
 * Instagram documents 750/hour for posts and Reels; we stop at 700 so our
 * count and Meta's never race to the edge. Facebook documents no fixed
 * number; Meta's throttling error is handled as a deferral there too.
 */
export const PRIVATE_REPLY_HOURLY_LIMITS: Readonly<
  Partial<Record<ChannelKind, number>>
> = {
  instagram: 700,
};

export type WindowResult =
  { allowed: true } | { allowed: false; retryAfterMs: number };

@Injectable()
export class CommentRateLimiter {
  constructor(@Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis) {}

  async acquireTenantSlot(tenantId: string): Promise<boolean> {
    const key = `comments:inflight:${tenantId}`;
    const count = await this.redis.incr(key);
    await this.redis.expire(key, TENANT_SLOT_TTL_SECONDS);
    if (count > COMMENT_TENANT_CONCURRENCY) {
      await this.redis.decr(key);
      return false;
    }
    return true;
  }

  async releaseTenantSlot(tenantId: string): Promise<void> {
    const key = `comments:inflight:${tenantId}`;
    const count = await this.redis.decr(key);
    // Never leave a negative count behind (a TTL expiry between acquire and
    // release would otherwise make the next acquire read -1 + 1 = 0).
    if (count < 0)
      await this.redis.set(key, '0', 'EX', TENANT_SLOT_TTL_SECONDS);
  }

  tenantReply(
    tenantId: string,
    limit: number,
    now: Date,
  ): Promise<WindowResult> {
    return this.hit(`comments:reply:tenant:${tenantId}`, limit, now);
  }

  postReply(
    tenantId: string,
    postId: string,
    limit: number,
    now: Date,
  ): Promise<WindowResult> {
    return this.hit(`comments:reply:post:${tenantId}:${postId}`, limit, now);
  }

  classify(tenantId: string, now: Date): Promise<WindowResult> {
    return this.hit(
      `comments:classify:${tenantId}`,
      COMMENT_CLASSIFY_HOURLY_LIMIT,
      now,
    );
  }

  /** The D11 private-reply limiter. Always allowed on a channel with no documented limit. */
  privateReply(
    channel: ChannelKind,
    channelAccountId: string,
    now: Date,
  ): Promise<WindowResult> {
    const limit = PRIVATE_REPLY_HOURLY_LIMITS[channel];
    if (limit === undefined) return Promise.resolve({ allowed: true });
    return this.hit(
      `comments:private-reply:${channel}:${channelAccountId}`,
      limit,
      now,
    );
  }

  private async hit(
    prefix: string,
    limit: number,
    now: Date,
  ): Promise<WindowResult> {
    const window = Math.floor(now.getTime() / HOUR_MS);
    const key = `${prefix}:${window}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, 2 * 60 * 60);
    }
    if (count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: (window + 1) * HOUR_MS - now.getTime(),
    };
  }
}
