import type Redis from 'ioredis';
import { WebhookRateLimiterService } from './webhook-rate-limiter.service';

function makeRedis(incrResults: number[]): {
  redis: Redis;
  incr: jest.Mock;
  expire: jest.Mock;
} {
  let call = 0;
  const incr = jest.fn(() =>
    Promise.resolve(incrResults[call++] ?? incrResults[incrResults.length - 1]),
  );
  const expire = jest.fn().mockResolvedValue(1);

  return { redis: { incr, expire } as unknown as Redis, incr, expire };
}

describe('WebhookRateLimiterService', () => {
  it('allows requests within the limit', async () => {
    const { redis } = makeRedis([1]);
    const service = new WebhookRateLimiterService(redis);

    await expect(service.allow('tenant-a', 5)).resolves.toBe(true);
  });

  it('sets an expiry only on the first increment in a window', async () => {
    const { redis, expire } = makeRedis([1]);
    const service = new WebhookRateLimiterService(redis);

    await service.allow('tenant-a', 5);

    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('does not re-set expiry on subsequent increments in the same window', async () => {
    const { redis, expire } = makeRedis([2]);
    const service = new WebhookRateLimiterService(redis);

    await service.allow('tenant-a', 5);

    expect(expire).not.toHaveBeenCalled();
  });

  it('rejects once the tenant exceeds its configured limit', async () => {
    const { redis } = makeRedis([6]);
    const service = new WebhookRateLimiterService(redis);

    await expect(service.allow('tenant-a', 5)).resolves.toBe(false);
  });

  it('namespaces the counter key per tenant, so one tenant flooding cannot exhaust another tenant’s budget', async () => {
    const { redis, incr } = makeRedis([1]);
    const service = new WebhookRateLimiterService(redis);

    await service.allow('tenant-a', 5);
    await service.allow('tenant-b', 5);

    const keys = incr.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(keys[0]).toContain('tenant-a');
    expect(keys[1]).toContain('tenant-b');
    expect(keys[0]).not.toBe(keys[1]);
  });
});
