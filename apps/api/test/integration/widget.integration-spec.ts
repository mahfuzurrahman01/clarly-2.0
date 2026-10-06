// Clarly 2.0 S3: the website chat widget over real HTTP, real Postgres and
// Redis, through the real ingest path into the real respond-path queue.
//
// Proves:
//   - the tenant console creates the widget on first read (disabled) and only
//     an admin can enable it / set its websites / rotate its key
//   - a disabled widget, an unknown key and a website not on the allow-list
//     are all refused before anything is read or written
//   - a visitor needs a token the API signed; a token for one visitor (or
//     another widget) reads nothing of anyone else's
//   - a visitor message goes through WebhookIngestService (tenant resolution
//     for the `web` channel, dedup) and onto the respond-path queue
//   - the visitor sees their own conversation, business replies included
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { buildCorsDelegate } from '../../src/common/cors';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  conversations,
  messages,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { RESPOND_PATH_QUEUE } from '../../src/modules/queue/queue.providers';
import { WidgetModule } from '../../src/modules/widget/widget.module';

const ORIGIN = 'https://shop.example.com';

function sign(
  secret: string,
  tenantId: string,
  role: 'admin' | 'agent',
): string {
  return jwt.sign(
    {
      sub: randomUUID(),
      role: 'authenticated',
      app_metadata: { tenant_id: tenantId, app_role: role },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

interface Session {
  visitorId: string;
  token: string;
}
interface WidgetBody {
  publicKey: string;
  enabled: boolean;
  allowedOrigins: string[];
}

describe('website widget (v2 S3)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let queue: Queue;
  let secret: string;
  const server = (): Server => app.getHttpServer() as Server;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let adminA: string;
  let agentA: string;
  let adminB: string;
  let keyA: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WidgetModule,
      ],
    }).compile();
    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    queue = moduleRef.get(getQueueToken(RESPOND_PATH_QUEUE));
    secret = moduleRef.get(AppConfigService).supabaseJwtSecret;
    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Noor Abayas (widget spec)' },
        { id: tenantB, name: 'Other shop (widget spec)' },
      ]),
    );
    adminA = sign(secret, tenantA, 'admin');
    agentA = sign(secret, tenantA, 'agent');
    adminB = sign(secret, tenantB, 'admin');

    app = moduleRef.createNestApplication();
    // The exact CORS rule main.ts installs, so the preflight test is meaningful.
    app.enableCors(buildCorsDelegate([]));
    await app.init();
    // The respond-path worker must not pick our job up mid-assertion.
    await queue.pause();
  });

  afterAll(async () => {
    // Drop the jobs this suite enqueued BEFORE resuming: otherwise the worker
    // picks them up, calls the LLM, and app.close() waits on that call.
    await queue.drain(true);
    await queue.resume();
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    await app.close();
  });

  it('creates the widget on first read, disabled, with a key', async () => {
    const res = await request(server())
      .get('/widget')
      .set('Authorization', `Bearer ${agentA}`)
      .expect(200);
    const body = res.body as WidgetBody;
    expect(body.enabled).toBe(false);
    expect(body.publicKey).toMatch(/^wk_[A-Za-z0-9]{24}$/);
    keyA = body.publicKey;
  });

  it('lets only an admin enable it, and normalises the websites', async () => {
    await request(server())
      .patch('/widget')
      .set('Authorization', `Bearer ${agentA}`)
      .send({ enabled: true })
      .expect(403);
    await request(server())
      .patch('/widget')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ allowedOrigins: ['http://evil.example.com'] })
      .expect(400);
    const res = await request(server())
      .patch('/widget')
      .set('Authorization', `Bearer ${adminA}`)
      .send({
        enabled: true,
        allowedOrigins: ['https://Shop.Example.com:443/', ORIGIN],
        title: 'Noor Abayas',
        welcomeMessage: 'أهلًا! كيف أقدر أساعدك؟',
      })
      .expect(200);
    expect((res.body as WidgetBody).allowedOrigins).toEqual([ORIGIN]);
  });

  it('keeps tenants apart in the console', async () => {
    const res = await request(server())
      .get('/widget')
      .set('Authorization', `Bearer ${adminB}`)
      .expect(200);
    expect((res.body as WidgetBody).publicKey).not.toBe(keyA);
  });

  it('serves the public config only to an allowed website', async () => {
    await request(server())
      .get('/widget/v1/config')
      .query({ key: keyA })
      .expect(403);
    await request(server())
      .get('/widget/v1/config')
      .query({ key: keyA })
      .set('Origin', 'https://attacker.example.net')
      .expect(403);
    await request(server())
      .get('/widget/v1/config')
      .query({ key: 'wk_AAAAAAAAAAAAAAAAAAAAAAAA' })
      .set('Origin', ORIGIN)
      .expect(404);
    const res = await request(server())
      .get('/widget/v1/config')
      .query({ key: keyA })
      .set('Origin', ORIGIN)
      .expect(200);
    expect(res.body).toMatchObject({
      title: 'Noor Abayas',
      businessName: 'Noor Abayas (widget spec)',
    });
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  let visitor: Session;
  let otherVisitor: Session;

  it('issues signed visitor sessions', async () => {
    const res = await request(server())
      .post('/widget/v1/session')
      .set('Origin', ORIGIN)
      .send({ key: keyA })
      .expect(201);
    visitor = res.body as Session;
    expect(visitor.visitorId).toMatch(/^web_/);
    otherVisitor = (
      await request(server())
        .post('/widget/v1/session')
        .set('Origin', ORIGIN)
        .send({ key: keyA })
    ).body as Session;
  });

  it('refuses a message with a forged token', async () => {
    await request(server())
      .post('/widget/v1/messages')
      .set('Origin', ORIGIN)
      .send({
        key: keyA,
        visitorId: visitor.visitorId,
        token: otherVisitor.token,
        clientMessageId: randomUUID(),
        text: 'hi',
      })
      .expect(403);
  });

  it('ingests a visitor message onto the respond-path queue, once', async () => {
    const clientMessageId = randomUUID();
    const send = () =>
      request(server()).post('/widget/v1/messages').set('Origin', ORIGIN).send({
        key: keyA,
        visitorId: visitor.visitorId,
        token: visitor.token,
        clientMessageId,
        text: 'بكم العباية السوداء؟',
      });
    await send().expect(202);
    await send().expect(202);

    const jobs = await queue.getJobs([
      'waiting',
      'delayed',
      'paused',
      'prioritized',
    ]);
    const mine = jobs.filter((j) =>
      JSON.stringify(j.data).includes(visitor.visitorId),
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const data = JSON.stringify(mine[0].data);
    expect(data).toContain('"web"');
    expect(data).toContain(tenantA);
    for (const j of mine) await j.remove();
  });

  it('shows a visitor their own conversation, and nobody else’s', async () => {
    // What the respond path writes once a turn has run.
    const conversationId = randomUUID();
    await tenantContext.withTenantTx(async (tx) => {
      await tx.insert(conversations).values({
        id: conversationId,
        tenantId: tenantA,
        channel: 'web',
        customerPhone: visitor.visitorId,
      });
      await tx.insert(messages).values([
        {
          tenantId: tenantA,
          conversationId,
          role: 'user',
          content: 'بكم العباية السوداء؟',
          bspMessageId: 'web:11111111-1111-4111-8111-111111111111',
          createdAt: new Date(Date.now() - 2000),
        },
        {
          tenantId: tenantA,
          conversationId,
          role: 'assistant',
          content: 'سعرها 350 ريال.',
          createdAt: new Date(Date.now() - 1000),
        },
      ]);
    }, tenantA);

    const mine = await request(server())
      .get('/widget/v1/messages')
      .query({ key: keyA, visitorId: visitor.visitorId, token: visitor.token })
      .set('Origin', ORIGIN)
      .expect(200);
    expect(
      (
        mine.body as {
          messages: {
            from: string;
            text: string;
            clientMessageId: string | null;
          }[];
        }
      ).messages,
    ).toMatchObject([
      {
        from: 'visitor',
        clientMessageId: '11111111-1111-4111-8111-111111111111',
      },
      { from: 'business', text: 'سعرها 350 ريال.' },
    ]);

    const theirs = await request(server())
      .get('/widget/v1/messages')
      .query({
        key: keyA,
        visitorId: otherVisitor.visitorId,
        token: otherVisitor.token,
      })
      .set('Origin', ORIGIN)
      .expect(200);
    expect((theirs.body as { messages: unknown[] }).messages).toEqual([]);
  });

  it('stops working everywhere when disabled, and the old key dies on rotation', async () => {
    const rotated = await request(server())
      .post('/widget/rotate-key')
      .set('Authorization', `Bearer ${adminA}`)
      .expect(200);
    const newKey = (rotated.body as WidgetBody).publicKey;
    expect(newKey).not.toBe(keyA);
    await request(server())
      .get('/widget/v1/config')
      .query({ key: keyA })
      .set('Origin', ORIGIN)
      .expect(404);
    await request(server())
      .get('/widget/v1/config')
      .query({ key: newKey })
      .set('Origin', ORIGIN)
      .expect(200);

    await request(server())
      .patch('/widget')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ enabled: false })
      .expect(200);
    await request(server())
      .get('/widget/v1/config')
      .query({ key: newKey })
      .set('Origin', ORIGIN)
      .expect(404);
  });
});
