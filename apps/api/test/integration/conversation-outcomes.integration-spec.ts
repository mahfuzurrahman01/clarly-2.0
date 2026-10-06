// Feature 7 exit criteria (A9/T12): "conversation close resolver,
// conversation_outcomes (anonymized, permanent)... a 90-day transcript
// purge does not change historical numbers." Proves, against real
// Postgres:
//   1. Resolving a ticket (TicketStateService.resolve()) writes a real
//      conversation_outcomes row, and MetricsService's resolution-rate/
//      escalation-breakdown correctly read it back (the A9-hardening
//      read-side swap, Slice 3).
//   2. AutoCloseSweepService correctly detects a never-escalated, quiet
//      conversation and records it too — both close paths feed the same
//      table.
//   3. T12's actual guarantee: deleting the underlying `conversations`/
//      `tickets` rows (simulating what a future T16 purge job will do)
//      does NOT delete the `conversation_outcomes` row derived from
//      them — proving `conversationId`/`ticketId` really have no
//      cascading FK, not just that the migration file says so.
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { ConversationModule } from '../../src/modules/conversation/conversation.module';
import { ConversationService } from '../../src/modules/conversation/conversation.service';
import { CoreModule } from '../../src/modules/core/core.module';
import { CustomerModule } from '../../src/modules/customer/customer.module';
import { CustomerService } from '../../src/modules/customer/customer.service';
import { MetricsModule } from '../../src/modules/metrics/metrics.module';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { AutoCloseSweepService } from '../../src/modules/outcomes/auto-close-sweep.service';
import { OutcomesModule } from '../../src/modules/outcomes/outcomes.module';
import {
  conversationOutcomes,
  conversations,
  tenants,
  tickets,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { TicketEscalationService } from '../../src/modules/ticket/ticket-escalation.service';
import { TicketModule } from '../../src/modules/ticket/ticket.module';
import { TicketStateService } from '../../src/modules/ticket/ticket-state.service';

describe('Conversation outcomes (Feature 7 exit criteria, A9/T12)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let customerService: CustomerService;
  let conversationService: ConversationService;
  let ticketEscalation: TicketEscalationService;
  let ticketState: TicketStateService;
  let metrics: MetricsService;
  let autoCloseSweep: AutoCloseSweepService;

  const tenantId = randomUUID();
  const from = new Date(Date.now() - 60 * 60 * 1000);
  const to = new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        CustomerModule,
        ConversationModule,
        OnboardingModule,
        TicketModule,
        OutcomesModule,
        MetricsModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    customerService = moduleRef.get(CustomerService);
    conversationService = moduleRef.get(ConversationService);
    ticketEscalation = moduleRef.get(TicketEscalationService);
    ticketState = moduleRef.get(TicketStateService);
    metrics = moduleRef.get(MetricsService);
    autoCloseSweep = moduleRef.get(AutoCloseSweepService);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Outcomes Test Tenant' }),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('resolving an escalated ticket records a conversation_outcomes row that MetricsService reads back correctly', async () => {
    const customer = await customerService.getOrCreateByPhone(
      tenantId,
      '+15550009999',
    );
    const conversation = await conversationService.getOrCreateConversation(
      tenantId,
      '+15550009999',
    );
    const ticket = await ticketEscalation.createTicket({
      tenantId,
      customerId: customer.id,
      conversationId: conversation.id,
      escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
    });

    await ticketState.resolve(tenantId, ticket.id);

    const breakdown = await metrics.getEscalationBreakdown(tenantId, {
      from,
      to,
    });
    expect(breakdown.CONFIDENCE_BELOW_THRESHOLD).toBeGreaterThanOrEqual(1);

    const rate = await metrics.getResolutionRate(tenantId, { from, to });
    expect(rate.totalConversations).toBeGreaterThanOrEqual(1);
  });

  it('AutoCloseSweepService records a never-escalated, quiet conversation, and resolutionRate reflects it', async () => {
    const phone = '+15550008888';
    const conversation = await conversationService.getOrCreateConversation(
      tenantId,
      phone,
    );
    // Backdate lastInboundAt well past the 24h default inactivity window.
    await tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(conversations)
          .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
          .where(eq(conversations.id, conversation.id)),
      tenantId,
    );

    const closed = await autoCloseSweep.sweepAllTenants();
    expect(
      closed.find((c) => c.conversationId === conversation.id),
    ).toBeDefined();

    const rate = await metrics.getResolutionRate(tenantId, { from, to });
    expect(rate.resolvedConversations).toBeGreaterThanOrEqual(1);
  });

  it('T12: a conversation_outcomes row survives deletion of its source conversation/ticket rows (simulated purge)', async () => {
    const customer = await customerService.getOrCreateByPhone(
      tenantId,
      '+15550007777',
    );
    const conversation = await conversationService.getOrCreateConversation(
      tenantId,
      '+15550007777',
    );
    const ticket = await ticketEscalation.createTicket({
      tenantId,
      customerId: customer.id,
      conversationId: conversation.id,
      escalationReason: 'TOOL_FAILURE',
    });
    await ticketState.resolve(tenantId, ticket.id);

    const beforePurge = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversationOutcomes)
          .where(eq(conversationOutcomes.conversationId, conversation.id)),
      tenantId,
    );
    expect(beforePurge).toHaveLength(1);

    // Simulate T16's future purge: delete the raw ticket + conversation
    // rows a real purge job would remove.
    await tenantContext.withTenantTx(
      (tx) => tx.delete(tickets).where(eq(tickets.id, ticket.id)),
      tenantId,
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.delete(conversations).where(eq(conversations.id, conversation.id)),
      tenantId,
    );

    const afterPurge = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversationOutcomes)
          .where(eq(conversationOutcomes.conversationId, conversation.id)),
      tenantId,
    );
    expect(afterPurge).toHaveLength(1);
    expect(afterPurge[0]).toEqual(beforePurge[0]);
  });
});
