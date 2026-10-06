// Feature 7 exit criteria (T9): "Instrument and enforce p95 <5s on the
// agent respond path... latency metric emitted per response; alert/log if
// p95 exceeds budget." Runs the real `LatencyBudgetCheckService.
// checkAllTenants()` (the same logic the BullMQ repeatable job drives —
// this test calls it directly rather than waiting on a real interval,
// same reasoning as `stuck-ticket-alerting.integration-spec.ts`) against
// real Postgres, proving the actual `percentile_cont` SQL aggregate
// works correctly, not just the surrounding service logic (already
// covered by unit tests with a stubbed query result).
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { AlertingModule } from '../../src/modules/alerting/alerting.module';
import { LatencyBudgetCheckService } from '../../src/modules/alerting/latency-budget-check.service';
import { CoreModule } from '../../src/modules/core/core.module';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import {
  agentRuns,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';

describe('Latency-budget alerting (Feature 7 exit criteria, T9)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let latencyBudgetCheck: LatencyBudgetCheckService;
  // Every tenant a test seeds is registered here so afterAll deletes only
  // those rows, never the whole `tenants` table.
  const createdTenantIds: string[] = [];

  async function seedAgentRuns(
    tenantIdForRuns: string,
    latencies: number[],
  ): Promise<void> {
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(agentRuns).values(
          latencies.map((latencyMs) => ({
            tenantId: tenantIdForRuns,
            conversationId: null,
            ticketId: null,
            status: 'success' as const,
            latencyMs,
            spans: {},
          })),
        ),
      tenantIdForRuns,
    );
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        OnboardingModule,
        AlertingModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    latencyBudgetCheck = moduleRef.get(LatencyBudgetCheckService);

    await persistence.runMigrations();
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, createdTenantIds)),
    );
    await moduleRef.close();
  });

  it('fires an alert when p95 latency exceeds the configured budget with enough samples', async () => {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Slow Tenant' }),
    );
    // 20 samples: 18 fast (1000ms), 2 very slow (9000ms) — p95 lands
    // above the 5000ms default budget without every sample needing to be
    // slow, proving this is a real percentile, not a naive max/average.
    await seedAgentRuns(tenantId, [
      ...Array<number>(18).fill(1000),
      9000,
      9000,
    ]);

    const alerts = await latencyBudgetCheck.checkAllTenants();
    const alert = alerts.find((a) => a.tenantId === tenantId);

    expect(alert).toBeDefined();
    expect(alert?.p95LatencyMs).toBeGreaterThan(5000);
    expect(alert?.sampleSize).toBe(20);
    expect(alert?.budgetMs).toBe(5000);
  });

  it('does not alert when every sample is comfortably within budget', async () => {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Fast Tenant' }),
    );
    await seedAgentRuns(tenantId, Array<number>(20).fill(500));

    const alerts = await latencyBudgetCheck.checkAllTenants();

    expect(alerts.find((a) => a.tenantId === tenantId)).toBeUndefined();
  });

  it('does not alert on a tenant with too few samples, even if every one was slow', async () => {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Sparse Slow Tenant' }),
    );
    await seedAgentRuns(tenantId, [9000, 9000, 9000]);

    const alerts = await latencyBudgetCheck.checkAllTenants();

    expect(alerts.find((a) => a.tenantId === tenantId)).toBeUndefined();
  });

  it('excludes status: "error" rows (always latencyMs: 0) from the p95 computation', async () => {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Error Rows Tenant' }),
    );
    // 20 real slow successes + 5 zero-latency error rows — if error rows
    // were included, they'd drag the computed p95 down and could mask a
    // real budget breach.
    await seedAgentRuns(tenantId, Array<number>(20).fill(9000));
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(agentRuns).values(
          Array.from({ length: 5 }, () => ({
            tenantId,
            conversationId: null,
            ticketId: null,
            status: 'error' as const,
            latencyMs: 0,
            spans: {},
          })),
        ),
      tenantId,
    );

    const alerts = await latencyBudgetCheck.checkAllTenants();
    const alert = alerts.find((a) => a.tenantId === tenantId);

    expect(alert).toBeDefined();
    expect(alert?.p95LatencyMs).toBeGreaterThanOrEqual(9000);
    expect(alert?.sampleSize).toBe(20);
  });
});
