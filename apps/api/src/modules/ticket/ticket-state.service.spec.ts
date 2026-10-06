import { NotFoundException } from '@nestjs/common';
import type { ConversationOutcomeService } from '../outcomes/conversation-outcome.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { InvalidTicketTransitionError } from './invalid-ticket-transition.error';
import { TicketStateService } from './ticket-state.service';
import type { TicketEventsService } from './ticket-events.service';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';

jest.mock('../notifications/notification-resolution', () => ({
  markEntityNotificationsRead: jest.fn().mockResolvedValue(1),
}));

const TENANT_A = 'tenant-a';
const TICKET_ID = 'ticket-1';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    tenantId: TENANT_A,
    customerId: 'customer-1',
    conversationId: 'conv-1',
    escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
    status: 'OPEN',
    note: null,
    assigneeId: null,
    confidence: null,
    citedChunkIds: null,
    claimedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Calls through to the real withTenantTx() callback — select for the pre-check read, update for the state transition itself. */
function makeTenantContext(
  selectResponse: unknown[],
  updateResponse?: unknown[],
): {
  tenantContext: TenantContextService;
  /** What each update() actually set — assignment's whole behaviour is in these values. */
  updates: Record<string, unknown>[];
} {
  let selectCall = 0;
  const updates: Record<string, unknown>[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const response =
                selectCall === 0
                  ? selectResponse
                  : (updateResponse ?? selectResponse);
              selectCall++;
              return Promise.resolve(response);
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve(updateResponse ?? selectResponse),
            }),
          };
        },
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    updates,
  };
}

function makeTicketEvents(): TicketEventsService {
  return { emitTicketChanged: jest.fn() } as unknown as TicketEventsService;
}

function makeConversationOutcome(): {
  service: ConversationOutcomeService;
  recordTicketResolved: jest.Mock;
} {
  const recordTicketResolved = jest.fn().mockResolvedValue(undefined);
  return {
    service: { recordTicketResolved } as unknown as ConversationOutcomeService,
    recordTicketResolved,
  };
}

describe('TicketStateService.claim()', () => {
  it('transitions an OPEN ticket to CLAIMED, setting assigneeId and claimedAt', async () => {
    const claimedRow = makeRow({
      status: 'CLAIMED',
      assigneeId: 'agent-1',
      claimedAt: new Date(),
    });
    const { tenantContext } = makeTenantContext([makeRow()], [claimedRow]);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    const result = await service.claim(TENANT_A, TICKET_ID, 'agent-1');

    expect(result.status).toBe('CLAIMED');
    expect(result.assigneeId).toBe('agent-1');
    expect(result.claimedAt).not.toBeNull();
  });

  it('throws InvalidTicketTransitionError when claiming an already-CLAIMED ticket', async () => {
    const { tenantContext } = makeTenantContext([
      makeRow({ status: 'CLAIMED' }),
    ]);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(
      service.claim(TENANT_A, TICKET_ID, 'agent-1'),
    ).rejects.toBeInstanceOf(InvalidTicketTransitionError);
  });

  it('throws InvalidTicketTransitionError when claiming a RESOLVED ticket', async () => {
    const { tenantContext } = makeTenantContext([
      makeRow({ status: 'RESOLVED' }),
    ]);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(
      service.claim(TENANT_A, TICKET_ID, 'agent-1'),
    ).rejects.toBeInstanceOf(InvalidTicketTransitionError);
  });

  it('throws NotFoundException for a nonexistent ticket', async () => {
    const { tenantContext } = makeTenantContext([]);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(
      service.claim(TENANT_A, TICKET_ID, 'agent-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TicketStateService.resolve()', () => {
  it('transitions an OPEN ticket directly to RESOLVED (claiming first is not required)', async () => {
    const resolvedRow = makeRow({ status: 'RESOLVED', resolvedAt: new Date() });
    const { tenantContext } = makeTenantContext(
      [makeRow({ status: 'OPEN' })],
      [resolvedRow],
    );
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    const result = await service.resolve(TENANT_A, TICKET_ID);

    expect(result.status).toBe('RESOLVED');
    expect(result.resolvedAt).not.toBeNull();
  });

  it('records a conversation_outcomes row via ConversationOutcomeService when the resolved ticket has a conversationId (A9)', async () => {
    const resolvedRow = makeRow({
      status: 'RESOLVED',
      resolvedAt: new Date(),
      conversationId: 'conv-1',
      escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
    });
    const { tenantContext } = makeTenantContext(
      [makeRow({ status: 'OPEN', conversationId: 'conv-1' })],
      [resolvedRow],
    );
    const conversationOutcome = makeConversationOutcome();
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      conversationOutcome.service,
    );

    await service.resolve(TENANT_A, TICKET_ID);

    expect(conversationOutcome.recordTicketResolved).toHaveBeenCalledWith(
      TENANT_A,
      'conv-1',
      'CONFIDENCE_BELOW_THRESHOLD',
    );
  });

  it('does not record a conversation_outcomes row when the resolved ticket has no conversationId (T3 non-agent-run tickets)', async () => {
    const resolvedRow = makeRow({
      status: 'RESOLVED',
      resolvedAt: new Date(),
      conversationId: null,
    });
    const { tenantContext } = makeTenantContext(
      [makeRow({ status: 'OPEN', conversationId: null })],
      [resolvedRow],
    );
    const conversationOutcome = makeConversationOutcome();
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      conversationOutcome.service,
    );

    await service.resolve(TENANT_A, TICKET_ID);

    expect(conversationOutcome.recordTicketResolved).not.toHaveBeenCalled();
  });

  it('transitions a CLAIMED ticket to RESOLVED', async () => {
    const resolvedRow = makeRow({ status: 'RESOLVED', resolvedAt: new Date() });
    const { tenantContext } = makeTenantContext(
      [makeRow({ status: 'CLAIMED' })],
      [resolvedRow],
    );
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(service.resolve(TENANT_A, TICKET_ID)).resolves.toMatchObject({
      status: 'RESOLVED',
    });
  });

  it('throws InvalidTicketTransitionError when resolving an already-RESOLVED ticket (terminal state)', async () => {
    const { tenantContext } = makeTenantContext([
      makeRow({ status: 'RESOLVED' }),
    ]);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(service.resolve(TENANT_A, TICKET_ID)).rejects.toBeInstanceOf(
      InvalidTicketTransitionError,
    );
  });

  it('throws NotFoundException for a nonexistent ticket', async () => {
    const { tenantContext } = makeTenantContext([]);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(service.resolve(TENANT_A, TICKET_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('TicketStateService.assign()', () => {
  function makeService(existing: Record<string, unknown>) {
    const { tenantContext, updates } = makeTenantContext(
      [makeRow(existing)],
      [makeRow({ ...existing, status: 'CLAIMED', assigneeId: 'agent-2' })],
    );
    return {
      service: new TicketStateService(
        tenantContext,
        makeTicketEvents(),
        makeConversationOutcome().service,
      ),
      updates,
    };
  }

  it('hands a CLAIMED ticket to someone else — the case claim() refuses and reassignment exists for', async () => {
    const { service, updates } = makeService({
      status: 'CLAIMED',
      assigneeId: 'agent-1',
    });

    await service.assign(TENANT_A, TICKET_ID, 'agent-2');

    expect(updates[0]).toMatchObject({
      status: 'CLAIMED',
      assigneeId: 'agent-2',
    });
  });

  it('restarts the unclaimed clock on reassignment, so the new owner is judged on their own time', async () => {
    const { service, updates } = makeService({
      status: 'CLAIMED',
      assigneeId: 'agent-1',
    });

    await service.assign(TENANT_A, TICKET_ID, 'agent-2');

    expect(updates[0].claimedAt).toBeInstanceOf(Date);
  });

  it('returns an unassigned ticket to OPEN — a CLAIMED ticket with nobody on it alerts nobody', async () => {
    const { service, updates } = makeService({
      status: 'CLAIMED',
      assigneeId: 'agent-1',
    });

    await service.assign(TENANT_A, TICKET_ID, null);

    expect(updates[0]).toMatchObject({
      status: 'OPEN',
      assigneeId: null,
      claimedAt: null,
    });
  });

  it('refuses to reassign a RESOLVED ticket rather than resurrecting finished work', async () => {
    const { service, updates } = makeService({ status: 'RESOLVED' });

    await expect(
      service.assign(TENANT_A, TICKET_ID, 'agent-2'),
    ).rejects.toBeInstanceOf(InvalidTicketTransitionError);
    expect(updates).toHaveLength(0);
  });
});

describe('TicketStateService.releaseAssignmentsFor()', () => {
  it('puts the departing member’s tickets back in the OPEN queue, unowned', async () => {
    const { tenantContext, updates } = makeTenantContext(
      [],
      [makeRow({ status: 'OPEN', assigneeId: null })],
    );
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(
      service.releaseAssignmentsFor(TENANT_A, 'agent-1'),
    ).resolves.toBe(1);
    expect(updates[0]).toEqual({
      status: 'OPEN',
      assigneeId: null,
      claimedAt: null,
    });
  });

  it('emits a change per released ticket, so an open board does not keep showing them as claimed', async () => {
    const { tenantContext } = makeTenantContext(
      [],
      [makeRow({ id: 't1' }), makeRow({ id: 't2' })],
    );
    const emitTicketChanged = jest.fn();
    const service = new TicketStateService(
      tenantContext,
      { emitTicketChanged } as unknown as TicketEventsService,
      makeConversationOutcome().service,
    );

    await service.releaseAssignmentsFor(TENANT_A, 'agent-1');

    expect(emitTicketChanged).toHaveBeenCalledTimes(2);
  });

  it('reports zero when the member held nothing', async () => {
    const { tenantContext } = makeTenantContext([], []);
    const service = new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );

    await expect(
      service.releaseAssignmentsFor(TENANT_A, 'agent-1'),
    ).resolves.toBe(0);
  });
});

// QA 2026-10-05: a stuck-ticket notification says "nobody has picked it up".
// Once somebody has, it is stale and must stop counting on the bell badge.
describe('TicketStateService — retiring the stuck-ticket notification', () => {
  const resolveMock = jest.mocked(markEntityNotificationsRead);
  beforeEach(() => resolveMock.mockClear());

  function service(select: unknown[], update?: unknown[]) {
    const { tenantContext } = makeTenantContext(select, update);
    return new TicketStateService(
      tenantContext,
      makeTicketEvents(),
      makeConversationOutcome().service,
    );
  }

  const expectRetired = () =>
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT_A,
      entityType: 'ticket',
      entityIds: [TICKET_ID],
      kinds: ['ticket_stuck'],
      readAt: expect.any(Date) as unknown,
    });

  it('retires it when the ticket is claimed', async () => {
    await service(
      [makeRow()],
      [makeRow({ status: 'CLAIMED', assigneeId: 'agent-1' })],
    ).claim(TENANT_A, TICKET_ID, 'agent-1');
    expectRetired();
  });

  it('retires it when the ticket is assigned to someone', async () => {
    await service(
      [makeRow()],
      [makeRow({ status: 'CLAIMED', assigneeId: 'agent-2' })],
    ).assign(TENANT_A, TICKET_ID, 'agent-2');
    expectRetired();
  });

  it('keeps it when the ticket is put back in the queue unassigned — nobody has it again', async () => {
    await service(
      [makeRow({ status: 'CLAIMED', assigneeId: 'agent-1' })],
      [makeRow({ status: 'OPEN' })],
    ).assign(TENANT_A, TICKET_ID, null);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('retires it when the ticket is resolved', async () => {
    await service(
      [makeRow()],
      [makeRow({ status: 'RESOLVED', resolvedAt: new Date() })],
    ).resolve(TENANT_A, TICKET_ID);
    expectRetired();
  });

  it('does nothing when the transition is refused', async () => {
    await expect(
      service([makeRow({ status: 'RESOLVED' })]).resolve(TENANT_A, TICKET_ID),
    ).rejects.toBeInstanceOf(InvalidTicketTransitionError);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
