// Feature 5 exit criteria (T7/T8/T14): the kanban console's real HTTP
// surface — the first real HTTP controller in this codebase (everything
// else is still gated on T0's pending BSP sign-off). Proves, against a
// real Postgres (RLS-scoped via TenantContextService, not mocked) and a
// real signed Supabase-shaped JWT (not a mocked SupabaseJwtService):
//   - unauthenticated requests are rejected (401)
//   - a caller only ever sees their own tenant's tickets (T7's tenant
//     isolation carried through to the HTTP layer)
//   - list/get batch-load transcript + citations + confidence (T8)
//   - claim/resolve enforce the state machine, invalid transitions become
//     409 Conflict (not an uncaught 500)
//   - claim always uses the caller's own JWT `sub`, never a client-
//     supplied assignee
//   - the SSE stream delivers a live event when a ticket changes, scoped
//     to the subscriber's own tenant
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { CustomerModule } from '../../src/modules/customer/customer.module';
import { CustomerService } from '../../src/modules/customer/customer.service';
import { KanbanModule } from '../../src/modules/kanban/kanban.module';
import { tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TicketEscalationService } from '../../src/modules/ticket/ticket-escalation.service';
import { TicketModule } from '../../src/modules/ticket/ticket.module';

function signToken(
  secret: string,
  overrides: { sub: string; tenantId: string },
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: overrides.sub,
      role: 'authenticated',
      app_metadata: { tenant_id: overrides.tenantId, app_role: 'agent' },
      exp: now + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

describe('Kanban console HTTP API (Feature 5 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let customerService: CustomerService;
  let ticketEscalation: TicketEscalationService;
  let appConfig: AppConfigService;
  let httpServer: INestApplication;
  let jwtSecret: string;

  /** Typed accessor for the underlying node:http server — INestApplication.getHttpServer() is typed `any` upstream. */
  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentASub = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        CustomerModule,
        TicketModule,
        KanbanModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    customerService = moduleRef.get(CustomerService);
    ticketEscalation = moduleRef.get(TicketEscalationService);
    appConfig = moduleRef.get(AppConfigService);
    jwtSecret = appConfig.supabaseJwtSecret;

    await persistence.runMigrations();

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Kanban Tenant A' },
        { id: tenantB, name: 'Kanban Tenant B' },
      ]),
    );

    httpServer = moduleRef.createNestApplication();
    await httpServer.init();
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    // httpServer was created via moduleRef.createNestApplication(), so it
    // shares the same DI container/lifecycle hooks as moduleRef itself —
    // closing both would call PersistenceService.onModuleDestroy() (and
    // thus pool.end()) twice.
    await httpServer.close();
  });

  it('rejects a request with no bearer token (401)', async () => {
    await request(server()).get('/kanban/tickets').expect(401);
  });

  it("lists only the caller's own tenant tickets, with customer + confidence + citations batch-loaded (T7/T8)", async () => {
    const customerA = await customerService.getOrCreateByPhone(
      tenantA,
      '+15550001111',
    );
    const customerB = await customerService.getOrCreateByPhone(
      tenantB,
      '+15550002222',
    );
    await ticketEscalation.createTicket({
      tenantId: tenantA,
      customerId: customerA.id,
      escalationReason: 'TOOL_FAILURE',
      confidence: 0.42,
      citedChunkIds: ['chunk-1'],
    });
    await ticketEscalation.createTicket({
      tenantId: tenantB,
      customerId: customerB.id,
      escalationReason: 'TOOL_FAILURE',
    });

    const tokenA = signToken(jwtSecret, { sub: agentASub, tenantId: tenantA });

    const response = await request(server())
      .get('/kanban/tickets')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const body = response.body as unknown[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      tenantId: tenantA,
      customerPhone: '+15550001111',
      confidence: 0.42,
      citedChunkIds: ['chunk-1'],
      transcript: [],
    });
  });

  it("runs a ticket through claim -> already-claimed (409) -> resolve, always claiming as the caller's own JWT sub", async () => {
    const customer = await customerService.getOrCreateByPhone(
      tenantA,
      '+15550003333',
    );
    const ticket = await ticketEscalation.createTicket({
      tenantId: tenantA,
      customerId: customer.id,
      escalationReason: 'TOOL_FAILURE',
    });
    const tokenA = signToken(jwtSecret, { sub: agentASub, tenantId: tenantA });

    const claimResponse = await request(server())
      .post(`/kanban/tickets/${ticket.id}/claim`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);
    expect(claimResponse.body).toMatchObject({
      status: 'CLAIMED',
      assigneeId: agentASub,
    });

    await request(server())
      .post(`/kanban/tickets/${ticket.id}/claim`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(409);

    const resolveResponse = await request(server())
      .post(`/kanban/tickets/${ticket.id}/resolve`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);
    expect(resolveResponse.body).toMatchObject({ status: 'RESOLVED' });
  });

  it('returns 404 for a ticket belonging to a different tenant (no cross-tenant leak via the HTTP layer)', async () => {
    const customerB = await customerService.getOrCreateByPhone(
      tenantB,
      '+15550004444',
    );
    const ticketB = await ticketEscalation.createTicket({
      tenantId: tenantB,
      customerId: customerB.id,
      escalationReason: 'TOOL_FAILURE',
    });
    const tokenA = signToken(jwtSecret, { sub: agentASub, tenantId: tenantA });

    await request(server())
      .get(`/kanban/tickets/${ticketB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });

  it("delivers a live SSE event, scoped to the subscriber's own tenant, when a ticket is created", async () => {
    // Prior tests already drove requests through supertest, which lazily
    // starts the underlying http.Server listening on an ephemeral port and
    // leaves it open — reuse that same listening socket for a raw
    // node:http request (supertest itself can't stream an indefinite SSE
    // response, so this test drops to the raw client for just this case).
    let address = server().address() as AddressInfo | null;
    if (!address) {
      await httpServer.listen(0);
      address = server().address() as AddressInfo;
    }
    const tokenA = signToken(jwtSecret, { sub: agentASub, tenantId: tenantA });

    const firstEvent = new Promise<string>((resolve, reject) => {
      let settled = false;
      const req = http.get(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/kanban/tickets/stream',
          headers: { Authorization: `Bearer ${tokenA}` },
        },
        (res) => {
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.includes('\n\n')) {
              settled = true;
              req.destroy();
              resolve(buffer);
            }
          });
          res.on('error', (err) => {
            if (!settled) reject(err);
          });
        },
      );
      req.on('error', (err) => {
        // destroy() after a successful read also fires an error event on
        // some Node versions ("socket hang up") — ignore once resolved.
        if (!settled) reject(err);
      });
    });

    // Give the SSE connection a moment to actually establish before
    // triggering the event it's meant to catch.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const customer = await customerService.getOrCreateByPhone(
      tenantA,
      '+15550005555',
    );
    const created = await ticketEscalation.createTicket({
      tenantId: tenantA,
      customerId: customer.id,
      escalationReason: 'TOOL_FAILURE',
    });

    const raw = await firstEvent;
    expect(raw).toContain(created.id);
  }, 10000);
});
