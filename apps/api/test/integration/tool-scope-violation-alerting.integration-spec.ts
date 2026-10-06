// T18 exit criteria: "Internal Alerting Completeness — no duplicate/
// flapping alerts on sustained conditions." Runs the real
// `ToolScopeViolationCheckService.checkAllTenants()` (the same logic the
// BullMQ repeatable job drives) against real Postgres, proving both the
// actual `agent_runs.escalation_reason = 'TOOL_SCOPE_VIOLATION'` count
// query works correctly, AND that `AlertDebouncer` genuinely suppresses
// a re-fire on a second sweep while the condition is still active — not
// just asserted against a stubbed query result (already covered by unit
// tests), the end-to-end behavior against a real DB.
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { AlertingModule } from '../../src/modules/alerting/alerting.module';
import { ToolScopeViolationCheckService } from '../../src/modules/alerting/tool-scope-violation-check.service';
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

describe('Tool-scope-violation alerting (T18 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let toolScopeViolationCheck: ToolScopeViolationCheckService;

  // Tenant ids created by this suite — cleaned up individually in
  // afterAll rather than a blanket `db.delete(tenants)` (the pattern
  // used by sibling alerting integration specs), so this suite can't
  // wipe tenant rows any other test/process may have seeded.
  const createdTenantIds: string[] = [];

  async function seedTenant(name: string): Promise<string> {
    const tenantId = randomUUID();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name }),
    );
    createdTenantIds.push(tenantId);
    return tenantId;
  }

  async function seedViolations(
    tenantIdForRuns: string,
    count: number,
  ): Promise<void> {
    if (count === 0) return;
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(agentRuns).values(
          Array.from({ length: count }, () => ({
            tenantId: tenantIdForRuns,
            conversationId: null,
            ticketId: null,
            status: 'escalated' as const,
            escalationReason: 'TOOL_SCOPE_VIOLATION',
            latencyMs: 100,
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
    toolScopeViolationCheck = moduleRef.get(ToolScopeViolationCheckService);

    await persistence.runMigrations();
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      await persistence.runAdminQuery((db) =>
        db.delete(tenants).where(eq(tenants.id, tenantId)),
      );
    }
    await moduleRef.close();
  });

  it('fires an alert when a tenant is at/over the configured threshold', async () => {
    const tenantId = await seedTenant('Probing Tenant');
    // Default threshold is 3 within a 5-minute window.
    await seedViolations(tenantId, 5);

    const alerts = await toolScopeViolationCheck.checkAllTenants();
    const alert = alerts.find((a) => a.tenantId === tenantId);

    expect(alert).toBeDefined();
    expect(alert?.violationCount).toBe(5);
  });

  it('does not alert a tenant below the threshold', async () => {
    const tenantId = await seedTenant('Quiet Tenant');
    await seedViolations(tenantId, 1);

    const alerts = await toolScopeViolationCheck.checkAllTenants();

    expect(alerts.find((a) => a.tenantId === tenantId)).toBeUndefined();
  });

  it('does not re-fire on a second sweep while the condition stays sustained (no flapping)', async () => {
    const tenantId = await seedTenant('Sustained Probing Tenant');
    await seedViolations(tenantId, 5);

    const firstSweep = await toolScopeViolationCheck.checkAllTenants();
    const secondSweep = await toolScopeViolationCheck.checkAllTenants();

    expect(firstSweep.find((a) => a.tenantId === tenantId)).toBeDefined();
    expect(secondSweep.find((a) => a.tenantId === tenantId)).toBeUndefined();
  });
});
