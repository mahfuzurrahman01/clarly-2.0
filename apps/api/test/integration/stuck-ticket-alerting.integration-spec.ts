// Feature 5 exit criteria (T4): "create test ticket, don't claim it,
// confirm alert fires at N minutes." Runs the real
// `StuckTicketCheckService.checkAllTenants()` (the same logic the BullMQ
// repeatable job drives — this test calls it directly rather than waiting
// on a real interval, since the scheduler itself is just BullMQ's
// `upsertJobScheduler`, already covered by a unit test) against real
// Postgres.
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { CustomerModule } from '../../src/modules/customer/customer.module';
import { CustomerService } from '../../src/modules/customer/customer.service';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { TenantPolicyService } from '../../src/modules/onboarding/tenant-policy.service';
import { tenants, tickets } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { AlertingModule } from '../../src/modules/alerting/alerting.module';
import { StuckTicketCheckService } from '../../src/modules/alerting/stuck-ticket-check.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { TicketEscalationService } from '../../src/modules/ticket/ticket-escalation.service';
import { TicketModule } from '../../src/modules/ticket/ticket.module';

describe('Stuck-ticket alerting (Feature 5 exit criteria, T4)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let customerService: CustomerService;
  let ticketEscalation: TicketEscalationService;
  let tenantPolicy: TenantPolicyService;
  let stuckTicketCheck: StuckTicketCheckService;

  const tenantId = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        CustomerModule,
        OnboardingModule,
        TicketModule,
        AlertingModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    customerService = moduleRef.get(CustomerService);
    ticketEscalation = moduleRef.get(TicketEscalationService);
    tenantPolicy = moduleRef.get(TenantPolicyService);
    stuckTicketCheck = moduleRef.get(StuckTicketCheckService);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Alerting Tenant' }),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('fires an alert for an unclaimed OPEN ticket once it crosses the tenant-configured threshold', async () => {
    // A 1-minute threshold keeps this test fast — T4's "N minutes" is
    // tenant-configurable specifically so it doesn't have to be Feature
    // 5's real-world default (15) to prove the mechanism works.
    await tenantPolicy.upsert(tenantId, { stuckTicketThresholdMinutes: 1 });

    const customer = await customerService.getOrCreateByPhone(
      tenantId,
      '+15559990000',
    );
    const ticket = await ticketEscalation.createTicket({
      tenantId,
      customerId: customer.id,
      escalationReason: 'TOOL_FAILURE',
    });

    // Freshly created — under the 1-minute threshold, no alert yet.
    const tooSoon = await stuckTicketCheck.checkAllTenants();
    expect(tooSoon.find((a) => a.ticketId === ticket.id)).toBeUndefined();

    // Backdate createdAt directly (real time can't be made to pass in a
    // fast test) to simulate the ticket having sat unclaimed for 5
    // minutes, well past the 1-minute threshold.
    await tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tickets)
          .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
          .where(eq(tickets.id, ticket.id)),
      tenantId,
    );

    const alerts = await stuckTicketCheck.checkAllTenants();
    const alert = alerts.find((a) => a.ticketId === ticket.id);

    expect(alert).toBeDefined();
    expect(alert?.tenantId).toBe(tenantId);
    expect(alert?.thresholdMinutes).toBe(1);
    expect(alert?.unclaimedMinutes).toBeGreaterThanOrEqual(5);
  });

  it('does not alert on a ticket that has already been claimed', async () => {
    await tenantPolicy.upsert(tenantId, { stuckTicketThresholdMinutes: 1 });
    const customer = await customerService.getOrCreateByPhone(
      tenantId,
      '+15559991111',
    );
    const ticket = await ticketEscalation.createTicket({
      tenantId,
      customerId: customer.id,
      escalationReason: 'TOOL_FAILURE',
    });

    // Backdate + claim, so it's old enough to qualify by age alone but no
    // longer OPEN — T8's batch loader's status filter should exclude it
    // before StuckTicketCheckService's own claimedAt guard even runs.
    await tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tickets)
          .set({
            createdAt: new Date(Date.now() - 5 * 60_000),
            status: 'CLAIMED',
            assigneeId: randomUUID(),
            claimedAt: new Date(),
          })
          .where(eq(tickets.id, ticket.id)),
      tenantId,
    );

    const alerts = await stuckTicketCheck.checkAllTenants();

    expect(alerts.find((a) => a.ticketId === ticket.id)).toBeUndefined();
  });
});
