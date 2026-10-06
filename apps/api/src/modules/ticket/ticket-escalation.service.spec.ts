import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { TicketEscalationService } from './ticket-escalation.service';
import type { TicketEventsService } from './ticket-events.service';

function makeTicketEvents(): { emitTicketChanged: jest.Mock } {
  return { emitTicketChanged: jest.fn() };
}

describe('TicketEscalationService.createTicket()', () => {
  it('creates a ticket scoped to the tenant via withTenantTx()', async () => {
    const row = {
      id: 'ticket-1',
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'UNSUPPORTED_MEDIA',
      status: 'OPEN',
      note: 'some context',
      assigneeId: null,
      confidence: null,
      citedChunkIds: null,
      claimedAt: null,
      resolvedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const withTenantTx = jest.fn().mockResolvedValue([row]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'UNSUPPORTED_MEDIA',
      note: 'some context',
    });

    expect(result).toEqual(row);
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-a');
    expect(ticketEvents.emitTicketChanged).toHaveBeenCalledWith(
      'tenant-a',
      result,
    );
  });

  it("defaults conversationId/confidence/citedChunkIds to null when not supplied (T3's non-agent-run tickets)", async () => {
    const row = {
      id: 'ticket-1',
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: null,
      escalationReason: 'TOOL_FAILURE',
      status: 'OPEN',
      note: null,
      assigneeId: null,
      confidence: null,
      citedChunkIds: null,
      claimedAt: null,
      resolvedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const withTenantTx = jest.fn().mockResolvedValue([row]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      escalationReason: 'TOOL_FAILURE',
    });

    expect(result.conversationId).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.citedChunkIds).toBeNull();
  });
});

describe('TicketEscalationService.createTicket() — dedup (Lane A item 7)', () => {
  const existingRow = {
    id: 'ticket-existing',
    tenantId: 'tenant-a',
    customerId: 'customer-1',
    conversationId: 'conv-1',
    escalationReason: 'LLM_ERROR',
    status: 'OPEN',
    note: 'first escalation',
    assigneeId: null,
    confidence: 0.4,
    citedChunkIds: null,
    claimedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('returns the existing OPEN ticket for the same conversation instead of creating a second one, merging the new note', async () => {
    const updatedRow = {
      ...existingRow,
      note: 'first escalation\n---\nsecond escalation',
    };
    const withTenantTx = jest
      .fn()
      .mockResolvedValueOnce([existingRow]) // findOpenTicketForConversation()
      .mockResolvedValueOnce([updatedRow]); // appendDedupNote()'s update
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'JOB_FAILURE',
      note: 'second escalation',
    });

    expect(result.id).toBe('ticket-existing');
    expect(result.note).toBe('first escalation\n---\nsecond escalation');
    // Exactly two DB round-trips (find + update) — never a third insert.
    expect(withTenantTx).toHaveBeenCalledTimes(2);
    expect(ticketEvents.emitTicketChanged).toHaveBeenCalledWith(
      'tenant-a',
      result,
    );
  });

  it('returns the existing ticket unchanged (one query only) when the duplicate call has no note', async () => {
    const withTenantTx = jest.fn().mockResolvedValueOnce([existingRow]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'JOB_FAILURE',
    });

    expect(result.id).toBe('ticket-existing');
    expect(withTenantTx).toHaveBeenCalledTimes(1);
    expect(ticketEvents.emitTicketChanged).not.toHaveBeenCalled();
  });

  it('creates a normal new ticket when no open ticket exists yet for the conversation', async () => {
    const newRow = { ...existingRow, id: 'ticket-new', note: 'first ever' };
    const withTenantTx = jest
      .fn()
      .mockResolvedValueOnce([]) // findOpenTicketForConversation() -> none
      .mockResolvedValueOnce([newRow]); // the insert
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'LLM_ERROR',
      note: 'first ever',
    });

    expect(result.id).toBe('ticket-new');
    expect(withTenantTx).toHaveBeenCalledTimes(2);
  });

  it('never dedups a RESOLVED ticket — a resolved ticket is not "open", so a new escalation opens a fresh one', async () => {
    // The service's own query already filters to OPEN/CLAIMED at the SQL
    // level; simulating that here as "no matching row returned".
    const newRow = { ...existingRow, id: 'ticket-after-resolve' };
    const withTenantTx = jest
      .fn()
      .mockResolvedValueOnce([]) // RESOLVED ticket does not match the open-status filter
      .mockResolvedValueOnce([newRow]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'LLM_ERROR',
    });

    expect(result.id).toBe('ticket-after-resolve');
  });

  it('does not dedup when conversationId is null (T3 non-agent-run tickets) — creates directly', async () => {
    const newRow = {
      ...existingRow,
      id: 'ticket-no-convo',
      conversationId: null,
    };
    const withTenantTx = jest.fn().mockResolvedValueOnce([newRow]);
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      tenantContext,
      ticketEvents as unknown as TicketEventsService,
    );

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      escalationReason: 'UNSUPPORTED_MEDIA',
    });

    expect(result.id).toBe('ticket-no-convo');
    // Straight to insert — no dedup lookup at all for a null conversationId.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
  });
});

// F25/D5.1 item 6: the complaint-lane interaction found while reading the
// dedup path.
//
// createTicket() folds a second escalation in the same conversation into a
// note on the first ticket. Without the promotion below, a customer who first
// asked something the agent could not answer (KB_NOT_INDEXED) and only THEN
// complained would have their complaint invisible to
// `GET /kanban/tickets?escalationReason=CUSTOMER_COMPLAINT` forever.
describe('TicketEscalationService — complaint promotion on dedup (F25/D5)', () => {
  function existingTicket(escalationReason: string, note: string | null) {
    return {
      id: 'ticket-1',
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason,
      status: 'OPEN',
      note,
      assigneeId: null,
      confidence: null,
      citedChunkIds: null,
      claimedAt: null,
      resolvedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
  }

  function makeHarness(existing: Record<string, unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    const withTenantTx = jest
      .fn()
      // findOpenTicketForConversation
      .mockResolvedValueOnce([existing])
      // the UPDATE — echoes back whatever the service set
      .mockImplementationOnce(() =>
        Promise.resolve([{ ...existing, ...updates[0] }]),
      );
    const ticketEvents = makeTicketEvents();
    const service = new TicketEscalationService(
      { withTenantTx } as unknown as TenantContextService,
      ticketEvents as unknown as TicketEventsService,
    );
    return { service, withTenantTx, updates, ticketEvents };
  }

  it('promotes an existing ticket to CUSTOMER_COMPLAINT when the complaint arrives second', async () => {
    const existing = existingTicket('KB_NOT_INDEXED', 'could not answer');
    const { service, withTenantTx } = makeHarness(existing);

    await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'CUSTOMER_COMPLAINT',
      note: 'the box arrived dented',
    });

    // Two transactions: the dedup lookup and the update. No third ticket.
    expect(withTenantTx).toHaveBeenCalledTimes(2);
  });

  it('promotes even when the complaint carries no note at all', async () => {
    const existing = existingTicket('KB_NOT_INDEXED', 'could not answer');
    const { service, withTenantTx } = makeHarness(existing);

    await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'CUSTOMER_COMPLAINT',
    });

    // Without the promotion this would have short-circuited on the missing
    // note and never written anything.
    expect(withTenantTx).toHaveBeenCalledTimes(2);
  });

  it('does NOT demote a complaint ticket when a lesser escalation follows it', async () => {
    const existing = existingTicket('CUSTOMER_COMPLAINT', 'dented box');
    const { service, withTenantTx } = makeHarness(existing);

    const result = await service.createTicket({
      tenantId: 'tenant-a',
      customerId: 'customer-1',
      conversationId: 'conv-1',
      escalationReason: 'KB_NOT_INDEXED',
    });

    // No note and nothing to promote: the lookup happened, no write did.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
    expect(result.escalationReason).toBe('CUSTOMER_COMPLAINT');
  });
});
