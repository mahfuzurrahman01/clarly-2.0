import { firstValueFrom, take, toArray } from 'rxjs';
import { TicketEventsService } from './ticket-events.service';
import type { TicketRecord } from './ticket.dto';

function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
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
    ...overrides,
  };
}

describe('TicketEventsService', () => {
  it('delivers an emitted ticket to a subscriber of the same tenant', async () => {
    const service = new TicketEventsService();
    const ticket = makeTicket();

    const received = firstValueFrom(
      service.subscribe('tenant-a').pipe(take(1)),
    );
    service.emitTicketChanged('tenant-a', ticket);

    await expect(received).resolves.toEqual(ticket);
  });

  it("never delivers a different tenant's ticket to a subscriber (tenant isolation at the fan-out layer)", async () => {
    const service = new TicketEventsService();
    const tenantATicket = makeTicket({ tenantId: 'tenant-a' });
    const tenantBTicket = makeTicket({
      id: 'ticket-2',
      tenantId: 'tenant-b',
    });

    const received = firstValueFrom(
      service.subscribe('tenant-a').pipe(take(1), toArray()),
    );
    service.emitTicketChanged('tenant-b', tenantBTicket);
    service.emitTicketChanged('tenant-a', tenantATicket);

    await expect(received).resolves.toEqual([tenantATicket]);
  });

  it('stops delivering events to an unsubscribed listener', () => {
    const service = new TicketEventsService();
    const seen: TicketRecord[] = [];
    const subscription = service
      .subscribe('tenant-a')
      .subscribe((t) => seen.push(t));

    subscription.unsubscribe();
    service.emitTicketChanged('tenant-a', makeTicket());

    expect(seen).toEqual([]);
  });
});
