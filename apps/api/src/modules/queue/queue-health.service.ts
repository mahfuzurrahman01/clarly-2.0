import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { QUEUE_REDIS_CONNECTION } from './queue.providers';

@Injectable()
export class QueueHealthService implements OnModuleDestroy {
  constructor(@Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis) {}

  /** Connects (if lazy) and confirms Redis is reachable — PONG round-trip. */
  async ping(): Promise<boolean> {
    const reply = await this.redis.ping();
    return reply === 'PONG';
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
