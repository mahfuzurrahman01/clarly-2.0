// Product shell (KanbanModule, T7/T8): the console API. The first real
// HTTP controller in this codebase — everything else (WebhookModule) is
// still gated on T0's pending BSP sign-off. `TenantAuthMiddleware` is
// applied to this whole controller (see kanban.module.ts's `configure()`)
// so every handler here has `req.auth` populated. No `@Roles()` gate on
// any of these routes: T14's spec draws the admin/agent line at
// team/tenant-config/policy access, not at ticket operations themselves —
// "Agent sees and acts on only their assigned/queue tickets" describes
// what an agent's dashboard shows (their claims + the open queue), not a
// server-side restriction on which tickets they're allowed to read/claim/
// resolve. See docs/decisions/F5-crm-platform.md, Slice 3.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { map } from 'rxjs';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { EntitlementGuard } from '../billing/entitlement.guard';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ApiErrorDto,
  ApiUnauthorizedResponse,
  ApiValidationErrorResponse,
} from '../../common/api-error.dto';
import { TicketEventsService } from '../ticket/ticket-events.service';
import { TicketQueryService } from '../ticket/ticket-query.service';
import { TicketStateService } from '../ticket/ticket-state.service';
import {
  TicketRecordDto,
  TicketWithContextDto,
  TicketWithContextListDto,
  type TicketRecord,
  type TicketWithContext,
} from '../ticket/ticket.dto';
import {
  assignTicketBodySchema,
  listTicketsQuerySchema,
  AssignTicketBodyDto,
  BoardConfigDto,
  ListTicketsQueryDto,
  TeamMemberListDto,
  type BoardConfig,
} from './kanban.dto';
import {
  TenantAuthProvisioningPort,
  type TeamMember,
} from '../onboarding/ports/tenant-auth-provisioning.port';
import { DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES } from '../onboarding/tenant-policy.dto';
import { TenantPolicyService } from '../onboarding/tenant-policy.service';
import { InvalidTicketTransitionFilter } from './invalid-ticket-transition.filter';

interface TicketSseEvent {
  data: TicketRecord;
}

/** Shared by the three `:id` routes — one description of the path param rather than three copies. */
const TICKET_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description:
    'Ticket id. A non-UUID value is rejected with 400 by ParseUUIDPipe.',
} as const;

@ApiTags('kanban')
@ApiBearerAuth()
@ApiUnauthorizedResponse()
// The SSE route references TicketRecord by `$ref` inside a raw `content`
// block, which the explorer can't discover on its own — register it.
@ApiExtraModels(TicketRecordDto)
@Controller('kanban/tickets')
@UseFilters(InvalidTicketTransitionFilter)
export class KanbanController {
  constructor(
    private readonly ticketQuery: TicketQueryService,
    private readonly ticketState: TicketStateService,
    private readonly ticketEvents: TicketEventsService,
    private readonly tenantPolicy: TenantPolicyService,
    private readonly provisioning: TenantAuthProvisioningPort,
  ) {}

  /** Declared before `:id` — Nest/Express match routes in declaration order, and `stream` would otherwise be swallowed by the `:id` param route. */
  @Sse('stream')
  @ApiOperation({
    summary: 'Stream ticket updates (SSE)',
    description:
      "**Not exercisable from this page.** This is a `text/event-stream` endpoint, not a JSON one — Swagger UI's Try-it-out will open the connection and appear to hang forever. Consume it with an `EventSource`/SSE client instead.\n\nEmits one event per ticket change in the calling tenant. Each event's `data` is a full ticket record.",
  })
  @ApiOkResponse({
    description:
      'An open `text/event-stream`. Each message `data` is a JSON ticket record.',
    content: {
      'text/event-stream': {
        schema: { $ref: getSchemaPath(TicketRecordDto) },
      },
    },
  })
  stream(@CurrentAuth() auth: TenantAuthContext): Observable<TicketSseEvent> {
    return this.ticketEvents
      .subscribe(auth.tenantId)
      .pipe(map((ticket) => ({ data: ticket })));
  }

  /** Declared before `:id` for the same reason as `stream` — otherwise the param route swallows it. */
  @Get('config')
  @ApiOperation({
    summary: 'Board configuration',
    description:
      'The policy values the console needs to render the board. Ungated by role: agents need the stuck-ticket threshold to see which tickets are overdue, while the full policy stays admin-only on `GET /onboarding/tenant-policy`.',
  })
  @ApiOkResponse({ type: BoardConfigDto })
  async config(@CurrentAuth() auth: TenantAuthContext): Promise<BoardConfig> {
    const policy = await this.tenantPolicy.getForTenant(auth.tenantId);
    return {
      stuckTicketThresholdMinutes:
        policy?.stuckTicketThresholdMinutes ??
        DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'List tickets',
    description:
      'Every ticket in the calling tenant, each with its customer details and the last 10 messages of its conversation. Ungated by role — both admin and agent tokens get the full tenant queue. Omit `status` to return all three states.',
  })
  @ApiOkResponse({ type: TicketWithContextListDto })
  @ApiValidationErrorResponse()
  list(
    @CurrentAuth() auth: TenantAuthContext,
    @Query(new ZodValidationPipe(listTicketsQuerySchema))
    query: ListTicketsQueryDto,
  ): Promise<TicketWithContext[]> {
    return this.ticketQuery.listWithContext(auth.tenantId, {
      status: query.status,
      // `me` is resolved here, never client-side: the console should not have
      // to know its own user id to ask for its own queue.
      assignee: query.assignee === 'me' ? auth.userId : query.assignee,
      // F25/D5.1: the Complaints lane is this filter, nothing more.
      escalationReason: query.escalationReason,
    });
  }

  @Get('team')
  @ApiOperation({
    summary: 'People a ticket can be assigned to',
    description:
      'Everyone whose claims put them in this workspace. Ungated by role: an agent handing a ticket to a colleague needs the same list an admin does.\n\nComes from the auth provider, since users do not live in this database. An empty list means the provider cannot answer (the `none` provisioning provider, for instance) — the board still works, it just has no picker.',
  })
  @ApiOkResponse({ type: TeamMemberListDto })
  team(@CurrentAuth() auth: TenantAuthContext): Promise<TeamMember[]> {
    return this.provisioning.listTeamMembers(auth.tenantId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one ticket',
    description:
      'A single ticket with customer context and transcript. Tickets belonging to another tenant return 404, not 403 — cross-tenant ids are indistinguishable from non-existent ones by design.',
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiOkResponse({ type: TicketWithContextDto })
  @ApiResponse({
    status: 404,
    description: 'No such ticket in the calling tenant.',
    type: ApiErrorDto,
  })
  async get(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketWithContext> {
    const ticket = await this.ticketQuery.getWithContext(auth.tenantId, id);
    if (!ticket) {
      throw new NotFoundException(`Ticket ${id} not found`);
    }
    return ticket;
  }

  /** `assigneeId` is always the caller's own userId, never client-supplied — claiming on another agent's behalf isn't a request parameter. */
  @Post(':id/claim')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Claim a ticket',
    description:
      "Assigns the ticket to the **calling** user and moves it OPEN → CLAIMED. There is no request body: claiming on another agent's behalf is deliberately not expressible. Claiming an already-claimed or resolved ticket returns 409.\n\nNote the 201 status — this route creates no resource and returns the updated ticket; the code is Nest's POST default, kept as-is so existing clients don't break.",
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiCreatedResponse({
    type: TicketRecordDto,
    description: 'The updated ticket, now CLAIMED by the caller.',
  })
  @ApiResponse({
    status: 409,
    description: 'The ticket is not OPEN, so it cannot be claimed.',
    type: ApiErrorDto,
  })
  claim(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketRecord> {
    return this.ticketState.claim(auth.tenantId, id, auth.userId);
  }

  @Post(':id/assign')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Assign a ticket to someone, or return it to the queue',
    description:
      'Hands the ticket to a named person, or to nobody when `assigneeId` is null.\n\nDistinct from claim: claiming is "I am taking this" and only works on an OPEN ticket, while reassignment has to work on one someone else already holds — that is the whole point of it. Reassigning restarts the unclaimed clock, so the new owner is judged on their own time rather than inheriting how long the last one sat on it. Unassigning puts the ticket back to OPEN, because a CLAIMED ticket with nobody on it is one that alerts nobody.\n\nA RESOLVED ticket is refused with 409: putting closed work back in a queue resurrects it.',
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiCreatedResponse({ type: TicketRecordDto })
  @ApiValidationErrorResponse()
  @ApiResponse({
    status: 409,
    description: 'The ticket is resolved, so it cannot be reassigned.',
    type: ApiErrorDto,
  })
  async assign(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignTicketBodySchema))
    body: AssignTicketBodyDto,
  ): Promise<TicketRecord> {
    if (body.assigneeId) {
      await this.requireTeamMember(auth.tenantId, body.assigneeId);
    }
    return this.ticketState.assign(auth.tenantId, id, body.assigneeId);
  }

  /**
   * A ticket may only be handed to someone actually in this workspace.
   * Without this any well-formed uuid is accepted — including another
   * tenant's user id — and the ticket goes to CLAIMED owned by nobody who
   * can see it: it leaves the open queue, alerts no one, and shows up in no
   * dashboard.
   *
   * An empty directory means the provider cannot answer (the `none`
   * provisioning provider), not that the workspace has no people in it, so
   * validation is skipped rather than failing every assignment — the same
   * reading of an empty list that `GET team` documents.
   */
  private async requireTeamMember(
    tenantId: string,
    assigneeId: string,
  ): Promise<void> {
    const members = await this.provisioning.listTeamMembers(tenantId);
    if (members.length === 0) return;
    if (!members.some((member) => member.userId === assigneeId)) {
      throw new BadRequestException(
        `${assigneeId} is not a member of this workspace.`,
      );
    }
  }

  @Post(':id/resolve')
  @UseGuards(EntitlementGuard)
  @ApiOperation({
    summary: 'Resolve a ticket',
    description:
      'Moves the ticket CLAIMED → RESOLVED. Resolving a ticket that is not currently CLAIMED returns 409. Same 201-instead-of-200 note as claim.',
  })
  @ApiParam(TICKET_ID_PARAM)
  @ApiCreatedResponse({
    type: TicketRecordDto,
    description: 'The updated ticket, now RESOLVED.',
  })
  @ApiResponse({
    status: 409,
    description: 'The ticket is not CLAIMED, so it cannot be resolved.',
    type: ApiErrorDto,
  })
  resolve(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketRecord> {
    return this.ticketState.resolve(auth.tenantId, id);
  }
}
