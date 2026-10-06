// Product shell (AlertingModule, T18): the 4 platform-level checks —
// circuit breaker open, queue/DLQ depth, tenant count threshold,
// dependency (Postgres/Redis) unreachable. Each is a pure read of state
// another module already tracks (CircuitBreakerLlmProvider.getState(),
// Queue.getFailedCount() — T11's "failed set IS the de facto DLQ" design,
// tenants row count, PersistenceService/QueueHealthService.ping()) — no
// new instrumentation. AlertDebouncer prevents re-firing every sweep
// while a condition stays sustained (T18's explicit "no flapping" verify
// requirement); each of the 4 conditions is debounced independently by a
// fixed key.
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { AppConfigService } from '../core';
import { CircuitBreakerLlmProvider } from '../llm/llm.module';
import { tenants } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { QueueHealthService } from '../queue/queue-health.service';
import { RESPOND_PATH_QUEUE } from '../queue/queue.providers';
import { AlertDebouncer } from './alert-debouncer';
import { AUTO_CLOSE_SWEEP_QUEUE } from '../outcomes/auto-close-sweep.queue';
import { KB_INGEST_QUEUE } from '../knowledge-base/kb-ingest.queue';
import { LATENCY_BUDGET_CHECK_QUEUE } from './latency-budget-check.queue';
import { PlatformHealthAlertEventsService } from './platform-health-alert-events.service';
import type { PlatformHealthAlert } from './platform-health-alert.dto';
import { STUCK_TICKET_CHECK_QUEUE } from './stuck-ticket-check.queue';
import { SUMMARIZE_QUEUE } from '../conversation/summarize.queue';
import { TRANSCRIPT_PURGE_QUEUE } from '../retention/transcript-purge.queue';

const DEBOUNCE_KEY_BREAKER = 'platform-health:circuit-breaker-open';
const DEBOUNCE_KEY_TENANT_COUNT = 'platform-health:tenant-count-threshold';
const DEBOUNCE_KEY_DB_UNREACHABLE = 'platform-health:dependency-unreachable:db';
const DEBOUNCE_KEY_REDIS_UNREACHABLE =
  'platform-health:dependency-unreachable:redis';
const debounceKeyForQueueDepth = (queueName: string): string =>
  `platform-health:queue-dlq-depth:${queueName}`;

@Injectable()
export class PlatformHealthCheckService {
  constructor(
    private readonly breaker: CircuitBreakerLlmProvider,
    private readonly persistence: PersistenceService,
    private readonly queueHealth: QueueHealthService,
    private readonly config: AppConfigService,
    private readonly debouncer: AlertDebouncer,
    private readonly alertEvents: PlatformHealthAlertEventsService,
    @InjectQueue(STUCK_TICKET_CHECK_QUEUE)
    private readonly stuckTicketQueue: Queue,
    @InjectQueue(LATENCY_BUDGET_CHECK_QUEUE)
    private readonly latencyBudgetQueue: Queue,
    @InjectQueue(TRANSCRIPT_PURGE_QUEUE)
    private readonly transcriptPurgeQueue: Queue,
    @InjectQueue(AUTO_CLOSE_SWEEP_QUEUE)
    private readonly autoCloseSweepQueue: Queue,
    @InjectQueue(KB_INGEST_QUEUE)
    private readonly kbIngestQueue: Queue,
    @InjectQueue(RESPOND_PATH_QUEUE)
    private readonly respondPathQueue: Queue,
    @InjectQueue(SUMMARIZE_QUEUE)
    private readonly summarizeQueue: Queue,
  ) {}

  private get monitoredQueues(): Queue[] {
    return [
      this.stuckTicketQueue,
      this.latencyBudgetQueue,
      this.transcriptPurgeQueue,
      this.autoCloseSweepQueue,
      this.kbIngestQueue,
      this.respondPathQueue,
      this.summarizeQueue,
    ];
  }

  /** Runs all 4 checks, firing (debounced) alerts as needed. Returns the batch actually fired this sweep — an empty array is the healthy/no-change case, not an error. */
  async checkAll(): Promise<PlatformHealthAlert[]> {
    const results = await Promise.all([
      Promise.resolve(this.checkCircuitBreaker()),
      this.checkQueueDepths(),
      this.checkTenantCount(),
      this.checkDependencies(),
    ]);

    return results.flat();
  }

  private checkCircuitBreaker(): PlatformHealthAlert[] {
    const state = this.breaker.getState();
    const isOpen = state === 'open';

    if (!this.debouncer.shouldFire(DEBOUNCE_KEY_BREAKER, isOpen)) return [];

    const alert: PlatformHealthAlert = {
      type: 'circuit_breaker_open',
      message:
        'LLM circuit breaker is open — respond path is failing over to escalation.',
      details: { state },
    };
    this.alertEvents.fire(alert);
    return [alert];
  }

  private async checkQueueDepths(): Promise<PlatformHealthAlert[]> {
    const threshold = this.config.queueDlqDepthThreshold;

    const perQueue = await Promise.all(
      this.monitoredQueues.map(async (queue) => {
        const failedCount = await queue.getFailedCount();
        const isOverThreshold = failedCount >= threshold;
        const key = debounceKeyForQueueDepth(queue.name);

        if (!this.debouncer.shouldFire(key, isOverThreshold)) return null;

        const alert: PlatformHealthAlert = {
          type: 'queue_dlq_depth',
          message: `Queue "${queue.name}" failed-job count (${failedCount}) has reached the DLQ depth threshold (${threshold}).`,
          details: { queue: queue.name, failedCount, threshold },
        };
        this.alertEvents.fire(alert);
        return alert;
      }),
    );

    return perQueue.filter(
      (alert): alert is PlatformHealthAlert => alert !== null,
    );
  }

  private async checkTenantCount(): Promise<PlatformHealthAlert[]> {
    const threshold = this.config.tenantCountAlertThreshold;

    const [row] = await this.persistence.runAdminQuery((db) =>
      db.select({ count: sql<number>`count(*)::int` }).from(tenants),
    );
    const tenantCount = row?.count ?? 0;
    const isOverThreshold = tenantCount >= threshold;

    if (
      !this.debouncer.shouldFire(DEBOUNCE_KEY_TENANT_COUNT, isOverThreshold)
    ) {
      return [];
    }

    const alert: PlatformHealthAlert = {
      type: 'tenant_count_threshold',
      message: `Tenant count (${tenantCount}) has reached the early-warning threshold (${threshold}) ahead of D3's pgvector -> Qdrant exit trigger.`,
      details: { tenantCount, threshold },
    };
    this.alertEvents.fire(alert);
    return [alert];
  }

  private async checkDependencies(): Promise<PlatformHealthAlert[]> {
    const [dbReachable, redisReachable] = await Promise.all([
      this.persistence.ping().catch(() => false),
      this.queueHealth.ping().catch(() => false),
    ]);

    const alerts: PlatformHealthAlert[] = [];

    if (this.debouncer.shouldFire(DEBOUNCE_KEY_DB_UNREACHABLE, !dbReachable)) {
      const alert: PlatformHealthAlert = {
        type: 'dependency_unreachable',
        message: 'Postgres is unreachable (ping failed).',
        details: { dependency: 'postgres' },
      };
      this.alertEvents.fire(alert);
      alerts.push(alert);
    }

    if (
      this.debouncer.shouldFire(DEBOUNCE_KEY_REDIS_UNREACHABLE, !redisReachable)
    ) {
      const alert: PlatformHealthAlert = {
        type: 'dependency_unreachable',
        message: 'Redis is unreachable (ping failed).',
        details: { dependency: 'redis' },
      };
      this.alertEvents.fire(alert);
      alerts.push(alert);
    }

    return alerts;
  }
}
