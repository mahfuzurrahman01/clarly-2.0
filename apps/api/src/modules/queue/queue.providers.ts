// Platform (QueueModule): shared ioredis connection, reused by
// BullModule.forRootAsync (queue.module.ts) and exposed for a lightweight
// connectivity ping (see QueueHealthService). Local/Docker Redis in
// dev/CI, Upstash Redis in prod per docs/decisions/F0-infra.md — the URL is
// the only thing that changes between environments, this factory doesn't
// branch on target.
import Redis from 'ioredis';
import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../core/config/app-config.service';

export const QUEUE_REDIS_CONNECTION = Symbol('QUEUE_REDIS_CONNECTION');

/** BullMQ queue name for T11's async job boundary — webhook ACKs, then this runs in a worker. */
export const RESPOND_PATH_QUEUE = 'respond-path';

/**
 * The one place a Redis client is built from REDIS_URL.
 *
 * ioredis is handed the URL whole and does its own parsing, which is the
 * point: a URL carries more than host and port. `redis://host:6379/9`
 * selects database 9, `rediss://` turns TLS on, and a managed provider
 * (Upstash, per F0-infra.md) puts a username in front of the password.
 * Decomposing the URL by hand and passing only host/port/password drops all
 * three silently — jobs land in db 0 next to another environment's, and a
 * `rediss://` target is dialled in plaintext and never connects.
 *
 * BullMQ's blocking commands (BRPOPLPUSH etc.) require
 * maxRetriesPerRequest: null on the underlying ioredis client — without it
 * BullMQ throws at startup. lazyConnect keeps app bootstrap from blocking on
 * Redis being reachable; QueueHealthService.ping() is the explicit
 * connectivity check used by the Feature 0 exit-criteria proof.
 *
 * ioredis's default retryStrategy retries the initial connection forever
 * with no error ever surfacing — so a scheduler's `onModuleInit()`
 * (upsertJobScheduler) awaits a promise that never settles, and
 * NestFactory.create() hangs before app.listen() is ever reached, silently,
 * with nothing in the logs. retryStrategy below caps that at
 * MAX_CONNECTION_RETRIES attempts before returning null (ioredis's signal to
 * stop retrying and reject pending commands with the underlying error), and
 * connectTimeout bounds how long a single attempt can hang against a
 * host that never responds (vs. one that actively refuses).
 */
const MAX_CONNECTION_RETRIES = 5;
const RETRY_DELAY_MS = 500;
const CONNECT_TIMEOUT_MS = 5000;

export function createQueueRedisClient(url: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy: (times: number): number | null => {
      if (times > MAX_CONNECTION_RETRIES) {
        return null;
      }
      return RETRY_DELAY_MS;
    },
  });
  // Without a listener, ioredis's 'error' event is an unhandled Node
  // EventEmitter error and crashes the process with an unhelpful stack.
  // Logging here (instead of doing nothing) keeps the failure visible while
  // letting the rejected command promise (e.g. upsertJobScheduler's) be the
  // thing that actually fails bootstrap.
  client.on('error', (error: Error) => {
    console.error(
      '[QueueRedisConnection] Redis connection error:',
      error.message,
    );
  });
  return client;
}

export const queueRedisConnectionProvider: Provider = {
  provide: QUEUE_REDIS_CONNECTION,
  useFactory: (config: AppConfigService): Redis =>
    createQueueRedisClient(config.redisUrl),
  inject: [AppConfigService],
};
