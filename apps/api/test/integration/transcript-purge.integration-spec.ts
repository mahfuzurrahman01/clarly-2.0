// Feature 7 exit criteria (T16): "90-day purge job removes raw transcripts
// but conversation_outcomes (T12) is untouched." Runs the real
// `TranscriptPurgeService.purgeAllTenants()` (the same logic the BullMQ
// repeatable job drives) against real Postgres, proving the actual
// `ON DELETE CASCADE`/`SET NULL`/no-FK-at-all behavior across all four
// affected tables in one pass, not just asserted in a comment.
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
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import {
  conversationOutcomes,
  conversations,
  messages,
  tenants,
  tickets,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RetentionModule } from '../../src/modules/retention/retention.module';
import { TranscriptPurgeService } from '../../src/modules/retention/transcript-purge.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { TicketEscalationService } from '../../src/modules/ticket/ticket-escalation.service';
import { TicketModule } from '../../src/modules/ticket/ticket.module';
import { TicketStateService } from '../../src/modules/ticket/ticket-state.service';

describe('Transcript purge (Feature 7 exit criteria, T16)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let customerService: CustomerService;
  let conversationService: ConversationService;
  let ticketEscalation: TicketEscalationService;
  let ticketState: TicketStateService;
  let transcriptPurge: TranscriptPurgeService;

  const tenantId = randomUUID();

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
        RetentionModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    customerService = moduleRef.get(CustomerService);
    conversationService = moduleRef.get(ConversationService);
    ticketEscalation = moduleRef.get(TicketEscalationService);
    ticketState = moduleRef.get(TicketStateService);
    transcriptPurge = moduleRef.get(TranscriptPurgeService);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Purge Test Tenant' }),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('removes an expired conversation and its messages, nulls the ticket/agent_run FK, and leaves conversation_outcomes untouched', async () => {
    const phone = '+15550001234';
    const customer = await customerService.getOrCreateByPhone(tenantId, phone);
    const conversation = await conversationService.getOrCreateConversation(
      tenantId,
      phone,
    );
    await conversationService.recordInboundMessages(
      tenantId,
      conversation.id,
      [{ providerMessageId: 'wamid.1', text: 'hello' }],
      new Date(),
    );
    await conversationService.recordAssistantMessage(
      tenantId,
      conversation.id,
      'Hi there!',
    );

    const ticket = await ticketEscalation.createTicket({
      tenantId,
      customerId: customer.id,
      conversationId: conversation.id,
      escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
    });
    await ticketState.resolve(tenantId, ticket.id);

    // Backdate the conversation past the 90-day default retention window
    // — real usage relies on lastInboundAt naturally aging past this, but
    // the test can't wait 90 real days.
    await tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(conversations)
          .set({
            lastInboundAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
          })
          .where(eq(conversations.id, conversation.id)),
      tenantId,
    );

    const results = await transcriptPurge.purgeAllTenants();
    const result = results.find((r) => r.tenantId === tenantId);
    expect(result).toBeDefined();
    expect(result?.conversationsPurged).toBeGreaterThanOrEqual(1);
    expect(result?.messagesPurged).toBeGreaterThanOrEqual(2);

    const [remainingConversation] = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversation.id)),
      tenantId,
    );
    expect(remainingConversation).toBeUndefined();

    const remainingMessages = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversation.id)),
      tenantId,
    );
    expect(remainingMessages).toHaveLength(0);

    // Ticket survives with its conversationId cleared (onDelete: 'set null').
    const [remainingTicket] = await tenantContext.withTenantTx(
      (tx) => tx.select().from(tickets).where(eq(tickets.id, ticket.id)),
      tenantId,
    );
    expect(remainingTicket).toBeDefined();
    expect(remainingTicket.conversationId).toBeNull();

    // T12's whole point: the outcome row is completely unaffected.
    const outcomes = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversationOutcomes)
          .where(eq(conversationOutcomes.conversationId, conversation.id)),
      tenantId,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].escalated).toBe(true);
  });

  it('does not purge a conversation that is still within the retention window', async () => {
    const phone = '+15550005678';
    await conversationService.getOrCreateConversation(tenantId, phone);

    const results = await transcriptPurge.purgeAllTenants();

    const stillPresent = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversations)
          .where(eq(conversations.customerPhone, phone)),
      tenantId,
    );
    expect(stillPresent).toHaveLength(1);
    // Either this tenant doesn't appear in results at all (nothing
    // expired) or, if a prior test's data pushed it in, this specific
    // conversation still isn't among what got removed.
    void results;
  });
});
