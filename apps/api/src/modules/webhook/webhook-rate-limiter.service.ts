// Channel (WebhookModule, T17): per-tenant token-bucket-equivalent rate
// limit on inbound webhooks. Implemented as a fixed-window counter in
// Redis (INCR + PEXPIRE on first increment) rather than a literal
// token-bucket algorithm — same rate-limiting guarantee (bounded requests
// per tenant per window) with one round-trip per check instead of a Lua
// script, which is enough for T17's actual requirement: "a webhook flood
// from one number does not starve other tenants' queue throughput." The
// key is namespaced per tenant, so one tenant's flood only ever fills
// their own window counter, never another tenant's.
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { QUEUE_REDIS_CONNECTION } from '../queue/queue.providers';

const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT_PER_WINDOW = 120;

@Injectable()
export class WebhookRateLimiterService {
  constructor(@Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis) {}

  /** True if this tenant is still within its per-minute inbound-webhook budget. */
  async allow(
    tenantId: string,
    limit: number = DEFAULT_LIMIT_PER_WINDOW,
  ): Promise<boolean> {
    const windowIndex = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const key = `ratelimit:webhook:${tenantId}:${windowIndex}`;

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }

    return count <= limit;
  }
}
