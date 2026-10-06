import { ServiceUnavailableException } from '@nestjs/common';
import type { PersistenceService } from '../persistence/persistence.service';
import type { QueueHealthService } from '../queue/queue-health.service';
import { HealthController } from './health.controller';

function makeController(
  dbReachable: boolean,
  redisReachable: boolean,
): HealthController {
  const persistence = {
    ping: jest.fn().mockResolvedValue(dbReachable),
  } as unknown as PersistenceService;
  const queueHealth = {
    ping: jest.fn().mockResolvedValue(redisReachable),
  } as unknown as QueueHealthService;

  return new HealthController(persistence, queueHealth);
}

describe('HealthController', () => {
  it('returns ok when both dependencies are reachable', async () => {
    const controller = makeController(true, true);

    const result = await controller.check();

    expect(result).toEqual({
      status: 'ok',
      dependencies: { postgres: true, redis: true },
    });
  });

  it('throws 503 when Postgres is unreachable', async () => {
    const controller = makeController(false, true);

    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws 503 when Redis is unreachable', async () => {
    const controller = makeController(true, false);

    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('treats a ping rejection as unreachable rather than propagating', async () => {
    const persistence = {
      ping: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PersistenceService;
    const queueHealth = {
      ping: jest.fn().mockResolvedValue(true),
    } as unknown as QueueHealthService;
    const controller = new HealthController(persistence, queueHealth);

    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
