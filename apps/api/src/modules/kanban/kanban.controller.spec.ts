import { BadRequestException, NotFoundException } from '@nestjs/common';
import { firstValueFrom, of, take } from 'rxjs';
import type { TenantAuthContext } from '../auth/jwt-claims';
import type { TicketEventsService } from '../ticket/ticket-events.service';
import type { TicketQueryService } from '../ticket/ticket-query.service';
import type { TicketStateService } from '../ticket/ticket-state.service';
import type { TicketRecord, TicketWithContext } from '../ticket/ticket.dto';
import type { TenantPolicyService } from '../onboarding/tenant-policy.service';
import type { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import { KanbanController } from './kanban.controller';
import { listTicketsQuerySchema } from './kanban.dto';

const AUTH: TenantAuthContext = {
  userId: 'agent-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'agent',
};

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

function makeTicketWithContext(
  overrides: Partial<TicketWithContext> = {},
): TicketWithContext {
  return {
    ...makeTicket(),
    customerPhone: '+15550001111',
    customerName: null,
    customerLabel: null,
    customerLabelSource: null,
    transcript: [],
    ...overrides,
  };
}

function makeController(): {
  controller: KanbanController;
  ticketQuery: { listWithContext: jest.Mock; getWithContext: jest.Mock };
  ticketState: { claim: jest.Mock; resolve: jest.Mock; assign: jest.Mock };
  provisioning: { listTeamMembers: jest.Mock };
  ticketEvents: { subscribe: jest.Mock };
  tenantPolicy: { getForTenant: jest.Mock };
} {
  const ticketQuery = {
    listWithContext: jest.fn(),
    getWithContext: jest.fn(),
  };
  const ticketState = {
    claim: jest.fn(),
    resolve: jest.fn(),
    assign: jest.fn(),
  };
  const provisioning = { listTeamMembers: jest.fn().mockResolvedValue([]) };
  const ticketEvents = { subscribe: jest.fn() };
  const tenantPolicy = { getForTenant: jest.fn() };

  const controller = new KanbanController(
    ticketQuery as unknown as TicketQueryService,
    ticketState as unknown as TicketStateService,
    ticketEvents as unknown as TicketEventsService,
    tenantPolicy as unknown as TenantPolicyService,
    provisioning as unknown as TenantAuthProvisioningPort,
  );

  return {
    controller,
    ticketQuery,
    ticketState,
    ticketEvents,
    tenantPolicy,
    provisioning,
  };
}

describe('KanbanController', () => {
  it("list() scopes the query to the caller's tenant and forwards the status filter", async () => {
    const { controller, ticketQuery } = makeController();
    const tickets = [makeTicketWithContext()];
    ticketQuery.listWithContext.mockResolvedValue(tickets);

    const result = await controller.list(AUTH, { status: 'OPEN' });

    expect(result).toBe(tickets);
    expect(ticketQuery.listWithContext).toHaveBeenCalledWith('tenant-a', {
      status: 'OPEN',
    });
  });

  it('get() returns the ticket when found', async () => {
    const { controller, ticketQuery } = makeController();
    const ticket = makeTicketWithContext();
    ticketQuery.getWithContext.mockResolvedValue(ticket);

    await expect(controller.get(AUTH, ticket.id)).resolves.toBe(ticket);
    expect(ticketQuery.getWithContext).toHaveBeenCalledWith(
      'tenant-a',
      ticket.id,
    );
  });

  it('get() throws NotFoundException when the ticket does not exist', async () => {
    const { controller, ticketQuery } = makeController();
    ticketQuery.getWithContext.mockResolvedValue(null);

    await expect(controller.get(AUTH, 'missing-ticket')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("claim() claims on the caller's own userId, never a client-supplied assignee", async () => {
    const { controller, ticketState } = makeController();
    const claimed = makeTicket({ status: 'CLAIMED', assigneeId: 'agent-1' });
    ticketState.claim.mockResolvedValue(claimed);

    const result = await controller.claim(AUTH, 'ticket-1');

    expect(result).toBe(claimed);
    expect(ticketState.claim).toHaveBeenCalledWith(
      'tenant-a',
      'ticket-1',
      'agent-1',
    );
  });

  // Any well-formed uuid used to be accepted, another tenant's user id
  // included. The ticket then leaves the open queue as CLAIMED by someone
  // who cannot see it: it alerts nobody and shows up in no dashboard.
  it('assign() refuses an assignee who is not in the workspace', async () => {
    const { controller, ticketState, provisioning } = makeController();
    provisioning.listTeamMembers.mockResolvedValue([
      { userId: 'agent-1', email: 'a@example.com', appRole: 'agent' },
    ]);

    await expect(
      controller.assign(AUTH, 'ticket-1', { assigneeId: 'outsider' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ticketState.assign).not.toHaveBeenCalled();
  });

  it('assign() hands the ticket over when the assignee is a member', async () => {
    const { controller, ticketState, provisioning } = makeController();
    provisioning.listTeamMembers.mockResolvedValue([
      { userId: 'agent-2', email: 'b@example.com', appRole: 'agent' },
    ]);
    const assigned = makeTicket({ status: 'CLAIMED', assigneeId: 'agent-2' });
    ticketState.assign.mockResolvedValue(assigned);

    const result = await controller.assign(AUTH, 'ticket-1', {
      assigneeId: 'agent-2',
    });

    expect(result).toBe(assigned);
    expect(ticketState.assign).toHaveBeenCalledWith(
      'tenant-a',
      'ticket-1',
      'agent-2',
    );
  });

  // An empty directory means the provider cannot answer (the `none`
  // provisioning provider), not that the workspace is empty — failing every
  // assignment there would break a board that otherwise works.
  it('assign() skips validation when the auth provider has no directory', async () => {
    const { controller, ticketState, provisioning } = makeController();
    provisioning.listTeamMembers.mockResolvedValue([]);
    ticketState.assign.mockResolvedValue(makeTicket({ status: 'CLAIMED' }));

    await controller.assign(AUTH, 'ticket-1', { assigneeId: 'agent-9' });

    expect(ticketState.assign).toHaveBeenCalled();
  });

  it('assign() unassigns without consulting the directory', async () => {
    const { controller, ticketState, provisioning } = makeController();
    ticketState.assign.mockResolvedValue(makeTicket({ status: 'OPEN' }));

    await controller.assign(AUTH, 'ticket-1', { assigneeId: null });

    expect(provisioning.listTeamMembers).not.toHaveBeenCalled();
    expect(ticketState.assign).toHaveBeenCalledWith(
      'tenant-a',
      'ticket-1',
      null,
    );
  });

  it('resolve() delegates to TicketStateService.resolve() scoped to the tenant', async () => {
    const { controller, ticketState } = makeController();
    const resolved = makeTicket({ status: 'RESOLVED' });
    ticketState.resolve.mockResolvedValue(resolved);

    const result = await controller.resolve(AUTH, 'ticket-1');

    expect(result).toBe(resolved);
    expect(ticketState.resolve).toHaveBeenCalledWith('tenant-a', 'ticket-1');
  });

  it("stream() subscribes to the caller's tenant and maps tickets into SSE message events", async () => {
    const { controller, ticketEvents } = makeController();
    const ticket = makeTicket();
    ticketEvents.subscribe.mockReturnValue(of(ticket));

    const event = await firstValueFrom(controller.stream(AUTH).pipe(take(1)));

    expect(ticketEvents.subscribe).toHaveBeenCalledWith('tenant-a');
    expect(event).toEqual({ data: ticket });
  });
});

describe('KanbanController.config', () => {
  it("returns the tenant's configured stuck-ticket threshold", async () => {
    const { controller, tenantPolicy } = makeController();
    tenantPolicy.getForTenant.mockResolvedValue({
      tenantId: 'tenant-a',
      confidenceThreshold: 0.7,
      forbiddenTopics: [],
      tonePersonaOverride: null,
      rerankEnabled: true,
      stuckTicketThresholdMinutes: 42,
    });

    await expect(controller.config(AUTH)).resolves.toEqual({
      stuckTicketThresholdMinutes: 42,
    });
    expect(tenantPolicy.getForTenant).toHaveBeenCalledWith('tenant-a');
  });

  it('falls back to the platform default when the tenant has no policy row', async () => {
    const { controller, tenantPolicy } = makeController();
    tenantPolicy.getForTenant.mockResolvedValue(null);

    await expect(controller.config(AUTH)).resolves.toEqual({
      stuckTicketThresholdMinutes: 15,
    });
  });
});

// F25/D5.1 item 4: the Complaints lane is a FILTER over `escalation_reason`,
// not a new column, a new board or a new table.
describe('KanbanController — the complaint lane (F25/D5)', () => {
  it('forwards the escalationReason filter to the existing query', async () => {
    const { controller, ticketQuery } = makeController();
    ticketQuery.listWithContext.mockResolvedValue([]);

    await controller.list(AUTH, { escalationReason: 'CUSTOMER_COMPLAINT' });

    expect(ticketQuery.listWithContext).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ escalationReason: 'CUSTOMER_COMPLAINT' }),
    );
  });

  it('accepts CUSTOMER_COMPLAINT in the query schema and rejects an invented reason', () => {
    expect(
      listTicketsQuerySchema.safeParse({
        escalationReason: 'CUSTOMER_COMPLAINT',
      }).success,
    ).toBe(true);
    expect(
      listTicketsQuerySchema.safeParse({ escalationReason: 'ANGRY' }).success,
    ).toBe(false);
  });
});
