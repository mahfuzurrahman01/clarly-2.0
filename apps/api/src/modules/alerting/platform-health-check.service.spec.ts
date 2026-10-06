import type { Queue } from 'bullmq';
import type { AppConfigService } from '../core';
import type { CircuitBreakerLlmProvider } from '../llm/llm.module';
import type { PersistenceService } from '../persistence/persistence.service';
import type { QueueHealthService } from '../queue/queue-health.service';
import { AlertDebouncer } from './alert-debouncer';
import type { PlatformHealthAlert } from './platform-health-alert.dto';
import { PlatformHealthAlertEventsService } from './platform-health-alert-events.service';
import { PlatformHealthCheckService } from './platform-health-check.service';

function makeQueue(name: string, failedCount = 0): Queue {
  return {
    name,
    getFailedCount: jest.fn().mockResolvedValue(failedCount),
  } as unknown as Queue;
}

function makeConfig(
  overrides: Partial<AppConfigService> = {},
): AppConfigService {
  return {
    queueDlqDepthThreshold: 20,
    tenantCountAlertThreshold: 400,
    ...overrides,
  } as AppConfigService;
}

function makeHarness(options?: {
  breakerState?: 'closed' | 'open' | 'half-open';
  tenantCount?: number;
  dbReachable?: boolean;
  redisReachable?: boolean;
  config?: Partial<AppConfigService>;
  queues?: Queue[];
}): {
  service: PlatformHealthCheckService;
  alertEvents: { fire: jest.Mock<void, [PlatformHealthAlert]> };
} {
  const breaker = {
    getState: jest.fn().mockReturnValue(options?.breakerState ?? 'closed'),
  } as unknown as CircuitBreakerLlmProvider;

  const persistence = {
    runAdminQuery: jest
      .fn()
      .mockImplementation((fn: (db: unknown) => unknown) =>
        fn({
          select: () => ({
            from: () => Promise.resolve([{ count: options?.tenantCount ?? 1 }]),
          }),
        }),
      ),
    ping: jest.fn().mockResolvedValue(options?.dbReachable ?? true),
  } as unknown as PersistenceService;

  const queueHealth = {
    ping: jest.fn().mockResolvedValue(options?.redisReachable ?? true),
  } as unknown as QueueHealthService;

  const alertEvents = { fire: jest.fn<void, [PlatformHealthAlert]>() };
  const config = makeConfig(options?.config);
  const debouncer = new AlertDebouncer();

  const queues =
    options?.queues ??
    [
      'stuck-ticket-check',
      'latency-budget-check',
      'transcript-purge',
      'auto-close-sweep',
      'kb-ingest',
      'respond-path',
      'conversation-summarize',
    ].map((name) => makeQueue(name));

  const service = new PlatformHealthCheckService(
    breaker,
    persistence,
    queueHealth,
    config,
    debouncer,
    alertEvents as unknown as PlatformHealthAlertEventsService,
    queues[0],
    queues[1],
    queues[2],
    queues[3],
    queues[4],
    queues[5],
    queues[6],
  );

  return { service, alertEvents };
}

describe('PlatformHealthCheckService.checkAll()', () => {
  it('fires a circuit_breaker_open alert when the breaker is open', async () => {
    const { service, alertEvents } = makeHarness({ breakerState: 'open' });

    const alerts = await service.checkAll();

    expect(alerts).toContainEqual(
      expect.objectContaining({ type: 'circuit_breaker_open' }),
    );
    expect(alertEvents.fire).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'circuit_breaker_open' }),
    );
  });

  it('does not alert when the breaker is closed', async () => {
    const { service } = makeHarness({ breakerState: 'closed' });

    const alerts = await service.checkAll();

    expect(alerts).not.toContainEqual(
      expect.objectContaining({ type: 'circuit_breaker_open' }),
    );
  });

  it('fires a queue_dlq_depth alert for a queue over threshold', async () => {
    const queues = [
      makeQueue('stuck-ticket-check'),
      makeQueue('latency-budget-check'),
      makeQueue('transcript-purge'),
      makeQueue('auto-close-sweep'),
      makeQueue('kb-ingest'),
      makeQueue('respond-path', 25),
      makeQueue('conversation-summarize'),
    ];
    const { service, alertEvents } = makeHarness({ queues });

    const alerts = await service.checkAll();

    expect(alerts).toContainEqual(
      expect.objectContaining({
        type: 'queue_dlq_depth',
        details: expect.objectContaining({ queue: 'respond-path' }) as unknown,
      }),
    );
    expect(alertEvents.fire).toHaveBeenCalled();
  });

  it('fires a tenant_count_threshold alert when at/over threshold', async () => {
    const { service } = makeHarness({
      tenantCount: 400,
      config: { tenantCountAlertThreshold: 400 },
    });

    const alerts = await service.checkAll();

    expect(alerts).toContainEqual(
      expect.objectContaining({ type: 'tenant_count_threshold' }),
    );
  });

  it('fires dependency_unreachable for postgres when ping fails', async () => {
    const { service } = makeHarness({ dbReachable: false });

    const alerts = await service.checkAll();

    expect(alerts).toContainEqual(
      expect.objectContaining({
        type: 'dependency_unreachable',
        details: expect.objectContaining({ dependency: 'postgres' }) as unknown,
      }),
    );
  });

  it('fires dependency_unreachable for redis when ping fails', async () => {
    const { service } = makeHarness({ redisReachable: false });

    const alerts = await service.checkAll();

    expect(alerts).toContainEqual(
      expect.objectContaining({
        type: 'dependency_unreachable',
        details: expect.objectContaining({ dependency: 'redis' }) as unknown,
      }),
    );
  });

  it('does not re-fire a sustained condition on a subsequent sweep', async () => {
    const { service, alertEvents } = makeHarness({ breakerState: 'open' });

    await service.checkAll();
    const secondSweep = await service.checkAll();

    expect(secondSweep).not.toContainEqual(
      expect.objectContaining({ type: 'circuit_breaker_open' }),
    );
    expect(
      alertEvents.fire.mock.calls.filter(
        (call) => call[0].type === 'circuit_breaker_open',
      ),
    ).toHaveLength(1);
  });

  it('returns an empty array when everything is healthy', async () => {
    const { service } = makeHarness();

    const alerts = await service.checkAll();

    expect(alerts).toEqual([]);
  });
});
