// Clarly 2.0 S3: public widget endpoints are on the open internet, so every
// one is limited per visitor AND per client IP in Redis (shared by every API
// replica — unlike Autologic's per-instance in-memory limiter). The tenant's
// own per-minute ingest budget (WebhookRateLimiterService) still applies on
// top, inside ingestMessages().
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { QUEUE_REDIS_CONNECTION } from '../queue/queue.providers';

export interface WidgetLimit {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

export const WIDGET_LIMITS = {
  /** Sessions minted per IP: stops one script creating visitors in a loop. */
  sessionPerIp: { limit: 20, windowSeconds: 600 },
  /** Messages sent per visitor. */
  sendPerVisitor: { limit: 20, windowSeconds: 60 },
  sendPerIp: { limit: 60, windowSeconds: 60 },
  /** Polls (the widget polls every few seconds while open). */
  readPerVisitor: { limit: 60, windowSeconds: 60 },
  configPerIp: { limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, WidgetLimit>;

@Injectable()
export class WidgetRateLimiterService {
  constructor(@Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis) {}

  /** True while `subject` is within `limit` for the current window. */
  async allow(
    bucket: string,
    subject: string,
    limit: WidgetLimit,
  ): Promise<boolean> {
    const window = Math.floor(Date.now() / 1000 / limit.windowSeconds);
    const key = `ratelimit:widget:${bucket}:${subject}:${window}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, limit.windowSeconds);
    return count <= limit.limit;
  }
}
