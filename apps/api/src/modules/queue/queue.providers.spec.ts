import { createQueueRedisClient } from './queue.providers';

describe('createQueueRedisClient', () => {
  afterEach(() => {
    // avoid leaking a live socket/timer between tests since lazyConnect never dials.
  });

  it('sets a bounded connect timeout instead of the ioredis default of hanging indefinitely', () => {
    const client = createQueueRedisClient('redis://localhost:6379');
    expect(client.options.connectTimeout).toBe(5000);
    void client.disconnect();
  });

  it('caps retries so a pending command eventually rejects instead of retrying forever', () => {
    const client = createQueueRedisClient('redis://localhost:6379');
    const retryStrategy = client.options.retryStrategy;
    expect(retryStrategy).toBeDefined();
    expect(retryStrategy?.(1)).toBe(500);
    expect(retryStrategy?.(5)).toBe(500);
    expect(retryStrategy?.(6)).toBeNull();
    void client.disconnect();
  });

  it('registers an error listener so a connection failure logs instead of crashing the process', () => {
    const client = createQueueRedisClient('redis://localhost:6379');
    expect(client.listenerCount('error')).toBeGreaterThan(0);
    void client.disconnect();
  });
});
