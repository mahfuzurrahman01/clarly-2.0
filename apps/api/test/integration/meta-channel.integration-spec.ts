// Feature 16 exit criteria, against real Postgres + Redis.
//
// The unit suite (`src/modules/webhook/meta-channel-ingest.spec.ts`) proves
// the ingest LOGIC is channel-agnostic with a fake dedup. This one proves the
// parts that only exist in a database and a queue:
//
//   - `social_channels` really does resolve a page/IG id to a tenant, before
//     any tenant context exists (T6);
//   - a replayed Messenger webhook is stopped by the REAL
//     unique(tenant_id, bsp_message_id) constraint on `webhook_message_dedup`
//     — the same constraint WhatsApp uses, not a per-channel copy — so
//     exactly one respond-path turn is queued;
//   - the queued job carries its channel and account, so the reply goes back
//     out the same Instagram/Messenger account it arrived on;
//   - a WhatsApp thread and a Messenger thread from the SAME identity string
//     stay two conversations rather than merging.
//
// Requires real Postgres + Redis (see apps/api/.env / docker-compose.yml) and
// runs via `npm run test:integration`.
//
// NOT covered here, and not coverable until Meta Tech Provider approval: that
// Meta's live payloads match the fixtures, and that a real page access token
// sends. Everything up to the Graph call is real code.
//
// Gulf T4 (D4) adds a second suite below: the server-side connect handshake
// over HTTP, with real Postgres + Redis and only the Graph client faked.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type Redis from 'ioredis';
import { AppConfigService } from '../../src/modules/core';
import {
  MetaGraphClient,
  MetaGraphError,
  type GraphManagedPage,
} from '../../src/modules/meta-graph/meta-graph.module';
import {
  hashMetaUserId,
  MetaChannelModule,
} from '../../src/modules/meta-channel/meta-channel.module';
import { SocialChannelCredentialsService } from '../../src/modules/meta-channel/social-channel-credentials.service';
import { QUEUE_REDIS_CONNECTION } from '../../src/modules/queue/queue.providers';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  conversations,
  socialChannels,
  tenants,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RESPOND_PATH_QUEUE } from '../../src/modules/queue/queue.providers';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { WebhookIngestService } from '../../src/modules/webhook/webhook-ingest.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';
import { UnknownChannelAccountError } from '../../src/modules/webhook/channel-tenant-resolver.service';
import type { CoalescedRespondJobData } from '../../src/modules/conversation/coalesced-respond-job.dto';
import type { NormalizedInboundMessage } from '../../src/modules/channel/ports/channel-adapter.port';
import type { ChannelKind } from '../../src/modules/channel/ports/channel-kind';
import { FixtureChannelAdapter } from './fixtures/fixture-channel.adapter';

describe('Meta social channel ingest (Feature 16 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let ingest: WebhookIngestService;
  let respondPathQueue: Queue<CoalescedRespondJobData>;

  const tenantId = randomUUID();
  const pageId = `page-${randomUUID()}`;
  const igAccountId = `ig-${randomUUID()}`;
  const igPageId = `page-for-ig-${randomUUID()}`;
  const phoneNumberId = `pn-${randomUUID()}`;

  const message = (
    channel: ChannelKind,
    channelAccountId: string,
    overrides: Partial<NormalizedInboundMessage> = {},
  ): NormalizedInboundMessage => ({
    channel,
    channelAccountId,
    providerMessageId: `mid.${randomUUID()}`,
    from: 'PSID-777',
    type: 'text',
    text: 'do you deliver to Sylhet?',
    receivedAt: new Date(),
    ...overrides,
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WebhookModule,
      ],
    }).compile();

    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    ingest = moduleRef.get(WebhookIngestService);
    respondPathQueue = moduleRef.get(getQueueToken(RESPOND_PATH_QUEUE));

    await persistence.runMigrations();

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Meta Channel Tenant' }),
    );
    // A WhatsApp number on the SAME tenant, so the cross-channel isolation
    // assertion below is about the channel and not about tenant routing.
    await persistence.runAdminQuery((db) =>
      db.insert(whatsappNumbers).values({
        tenantId,
        phoneNumberId,
        bspCredentialsEncrypted: 'not-real-ciphertext-for-this-test',
      }),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(socialChannels).values([
        {
          tenantId,
          channel: 'messenger',
          channelAccountId: pageId,
          // Messenger: the account it arrives on and the account it sends
          // from are the same page.
          pageId,
          credentialsEncrypted: 'not-real-ciphertext-for-this-test',
        },
        {
          tenantId,
          channel: 'instagram',
          channelAccountId: igAccountId,
          // Instagram: they are NOT the same, which is the whole reason
          // social_channels carries two id columns.
          pageId: igPageId,
          credentialsEncrypted: 'not-real-ciphertext-for-this-test',
        },
      ]),
    );
  });

  afterAll(async () => {
    await respondPathQueue.obliterate({ force: true });
    await persistence.runAdminQuery((db) =>
      db.delete(socialChannels).where(eq(socialChannels.tenantId, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(whatsappNumbers).where(eq(whatsappNumbers.tenantId, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('resolves a Facebook page id to its tenant through social_channels (T6)', async () => {
    const adapter = new FixtureChannelAdapter('messenger', [
      message('messenger', pageId),
    ]);

    const [result] = await ingest.ingest(
      adapter,
      '{}',
      FixtureChannelAdapter.validHeaders(),
    );

    expect(result.outcome).toBe('enqueued');
  });

  it('rejects a webhook for a page no tenant has connected, before any tenant-scoped work', async () => {
    const adapter = new FixtureChannelAdapter('messenger', [
      message('messenger', 'page-nobody-connected'),
    ]);

    await expect(
      ingest.ingest(adapter, '{}', FixtureChannelAdapter.validHeaders()),
    ).rejects.toBeInstanceOf(UnknownChannelAccountError);
  });

  it.each([
    ['messenger', () => pageId],
    ['instagram', () => igAccountId],
  ] as const)(
    'a replayed %s webhook produces exactly one reply, never two (T6)',
    async (channel, accountIdOf) => {
      // Feature 16's headline exit criterion, on the real unique constraint.
      const inbound = message(channel, accountIdOf());
      const adapter = new FixtureChannelAdapter(channel, [inbound]);
      const headers = FixtureChannelAdapter.validHeaders();

      const first = await ingest.ingest(adapter, '{}', headers);
      const replay = await ingest.ingest(adapter, '{}', headers);

      expect(first).toEqual([
        { providerMessageId: inbound.providerMessageId, outcome: 'enqueued' },
      ]);
      expect(replay).toEqual([
        { providerMessageId: inbound.providerMessageId, outcome: 'duplicate' },
      ]);
    },
  );

  it('carries the channel and account onto the queue, so the reply leaves from the same account', async () => {
    const inbound = message('instagram', igAccountId, { from: 'IGSID-4242' });
    const adapter = new FixtureChannelAdapter('instagram', [inbound]);

    await ingest.ingest(adapter, '{}', FixtureChannelAdapter.validHeaders());

    // The debounce window means the job is still 'delayed' — read it straight
    // off the queue rather than waiting for a turn we have no LLM for here.
    const jobs = await respondPathQueue.getDelayed();
    const job = jobs.find((candidate) => candidate.data.from === 'IGSID-4242');

    expect(job?.data).toMatchObject({
      tenantId,
      channel: 'instagram',
      channelAccountId: igAccountId,
      from: 'IGSID-4242',
    });
  });

  it('keeps a WhatsApp thread and a Messenger thread from the same identity string separate', async () => {
    // Both "15551234567". Without `channel` in the conversations key, these
    // two different people would share one thread and one transcript.
    const identity = '15551234567';

    await ingest.ingest(
      new FixtureChannelAdapter('whatsapp', [
        message('whatsapp', phoneNumberId, {
          from: identity,
          type: 'image',
          text: undefined,
          media: {
            mediaId: 'media-1',
            mimeType: 'image/jpeg',
            filename: null,
            caption: null,
          },
        }),
      ]),
      '{}',
      FixtureChannelAdapter.validHeaders(),
    );
    await ingest.ingest(
      new FixtureChannelAdapter('messenger', [
        message('messenger', pageId, {
          from: identity,
          type: 'image',
          text: undefined,
          media: {
            mediaId: 'https://cdn/x',
            mimeType: 'image/jpeg',
            filename: null,
            caption: null,
          },
        }),
      ]),
      '{}',
      FixtureChannelAdapter.validHeaders(),
    );

    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            channel: conversations.channel,
            phoneNumberId: conversations.phoneNumberId,
          })
          .from(conversations)
          .where(eq(conversations.customerPhone, identity)),
      tenantId,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.channel).sort()).toEqual([
      'messenger',
      'whatsapp',
    ]);
  });
});

describe('Meta social connect handshake over HTTP (Gulf T4 / D4)', () => {
  let app: INestApplication;
  let persistence: PersistenceService;
  let credentials: SocialChannelCredentialsService;
  let redis: Redis;
  let jwtSecret: string;
  const server = (): Server => app.getHttpServer() as Server;

  const run = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();
  const metaUserA = `${Date.now()}01`;
  const metaUserB = `${Date.now()}02`;
  const pageA = `page-a-${run}`;
  const igA = `ig-a-${run}`;
  const pageB = `page-b-${run}`;
  const pageFail = `page-fail-${run}`;
  const allAccounts = [pageA, igA, pageB, pageFail];

  interface FakeLogin {
    longLived: string;
    metaUserId: string;
    pages: GraphManagedPage[];
  }

  /** Meta's view of the world, keyed by short-lived login token. */
  const logins: Record<string, FakeLogin> = {
    [`login-a-${run}`]: {
      longLived: `long-a-${run}`,
      metaUserId: metaUserA,
      pages: [
        {
          id: pageA,
          name: 'Shop A',
          accessToken: `page-token-a-${run}`,
          instagram: { id: igA, username: 'shop.a' },
        },
        {
          id: pageFail,
          name: 'Subscription fails',
          accessToken: `page-token-fail-${run}`,
          instagram: null,
        },
      ],
    },
    [`login-b-${run}`]: {
      longLived: `long-b-${run}`,
      metaUserId: metaUserB,
      pages: [
        {
          id: pageB,
          name: 'Shop B',
          accessToken: `page-token-b-${run}`,
          instagram: null,
        },
        // Tenant B's Facebook user ALSO admins page A (an agency, say). That
        // must not let tenant B take it from tenant A.
        {
          id: pageA,
          name: 'Shop A',
          accessToken: `page-token-a-via-b-${run}`,
          instagram: { id: igA, username: 'shop.a' },
        },
      ],
    },
  };

  function byLongLived(token: string): FakeLogin {
    const login = Object.values(logins).find(
      (candidate) => candidate.longLived === token,
    );
    if (!login) throw new Error(`unexpected token in fake graph`);
    return login;
  }

  const fakeGraph = {
    exchangeLongLivedUserToken: jest.fn(
      ({ userAccessToken }: { userAccessToken: string }) => {
        const login = logins[userAccessToken];
        if (!login) {
          return Promise.reject(
            new MetaGraphError(400, 190, null, 'Invalid OAuth access token.'),
          );
        }
        return Promise.resolve({
          accessToken: login.longLived,
          expiresInSeconds: 5_184_000,
        });
      },
    ),
    getMe: jest.fn((token: string) =>
      Promise.resolve({ id: byLongLived(token).metaUserId }),
    ),
    listPages: jest.fn((token: string) =>
      Promise.resolve(byLongLived(token).pages),
    ),
    subscribeApp: jest.fn(({ pageId }: { pageId: string }) =>
      pageId === pageFail
        ? Promise.reject(
            new MetaGraphError(
              403,
              200,
              null,
              'Requires pages_manage_metadata',
            ),
          )
        : Promise.resolve(),
    ),
    inspectToken: jest.fn(() =>
      Promise.resolve({ valid: true, expiresAt: null }),
    ),
  };

  function bearer(tenantId: string, userId: string): string {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: userId,
        role: 'authenticated',
        app_metadata: { tenant_id: tenantId, app_role: 'admin' },
        exp: now + 3600,
      },
      jwtSecret,
      { algorithm: 'HS256', noTimestamp: true },
    );
    return `Bearer ${token}`;
  }

  async function startHandshake(
    tenantId: string,
    userId: string,
    loginToken: string,
  ): Promise<{ handshakeId: string }> {
    const response = await request(server())
      .post('/channels/meta/pages')
      .set('Authorization', bearer(tenantId, userId))
      .send({ userAccessToken: loginToken })
      .expect(200);
    return response.body as { handshakeId: string };
  }

  async function storedRows() {
    return persistence.runAdminQuery((db) =>
      db
        .select()
        .from(socialChannels)
        .where(inArray(socialChannels.channelAccountId, allAccounts)),
    );
  }

  async function storedRow(channelAccountId: string) {
    return (await storedRows()).find(
      (row) => row.channelAccountId === channelAccountId,
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        MetaChannelModule,
      ],
    })
      .overrideProvider(MetaGraphClient)
      .useValue(fakeGraph)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    persistence = moduleRef.get(PersistenceService);
    credentials = moduleRef.get(SocialChannelCredentialsService);
    redis = moduleRef.get(QUEUE_REDIS_CONNECTION);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'T4 Tenant A' },
        { id: tenantB, name: 'T4 Tenant B' },
      ]),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db
        .delete(socialChannels)
        .where(inArray(socialChannels.tenantId, [tenantA, tenantB])),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    await app.close();
  });

  it('step A lists pages + linked IG accounts with no token in the response or in Redis', async () => {
    const response = await request(server())
      .post('/channels/meta/pages')
      .set('Authorization', bearer(tenantA, adminA))
      .send({ userAccessToken: `login-a-${run}` })
      .expect(200);

    const body = response.body as {
      handshakeId: string;
      expiresAt: string;
      pages: unknown[];
    };
    expect(body.handshakeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.pages).toEqual([
      { id: pageA, name: 'Shop A', instagram: { id: igA, username: 'shop.a' } },
      { id: pageFail, name: 'Subscription fails', instagram: null },
    ]);
    expect(response.text).not.toContain(`long-a-${run}`);
    expect(response.text).not.toContain('page-token');

    const key = `meta-connect:handshake:${body.handshakeId}`;
    const stored = await redis.get(key);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(`long-a-${run}`);
    expect(stored).not.toContain(`page-token-a-${run}`);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });

  it('step A: a login token Meta rejects is a 400', async () => {
    await request(server())
      .post('/channels/meta/pages')
      .set('Authorization', bearer(tenantA, adminA))
      .send({ userAccessToken: 'not-a-real-login' })
      .expect(400);
  });

  it('requires a bearer token (TenantAuthMiddleware is applied)', async () => {
    await request(server())
      .post('/channels/meta/pages')
      .send({ userAccessToken: `login-a-${run}` })
      .expect(401);
  });

  it('step B connects Messenger + Instagram with Meta-issued tokens, the user token and the /me id', async () => {
    const { handshakeId } = await startHandshake(
      tenantA,
      adminA,
      `login-a-${run}`,
    );

    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantA, adminA))
      .send({
        handshakeId,
        pageId: pageA,
        channels: ['messenger', 'instagram'],
      })
      .expect(204);

    expect(await storedRow(pageA)).toMatchObject({
      tenantId: tenantA,
      channel: 'messenger',
      pageId: pageA,
      displayName: 'Shop A',
      connectionState: 'connected',
      connectedByMetaUserHash: hashMetaUserId(metaUserA),
    });
    expect(await storedRow(igA)).toMatchObject({
      tenantId: tenantA,
      channel: 'instagram',
      pageId: pageA,
      displayName: 'shop.a',
      connectedByMetaUserHash: hashMetaUserId(metaUserA),
    });
    await expect(credentials.getCredentials(pageA)).resolves.toEqual({
      pageAccessToken: `page-token-a-${run}`,
      userAccessToken: `long-a-${run}`,
    });

    const list = await request(server())
      .get('/channels/meta')
      .set('Authorization', bearer(tenantA, adminA))
      .expect(200);
    const ids = (list.body as { channelAccountId: string }[]).map(
      (row) => row.channelAccountId,
    );
    expect(ids.sort()).toEqual([igA, pageA].sort());
    expect(list.text).not.toContain('page-token');
  });

  it('SQUAT REGRESSION: a page the login does not manage is a 403 and stores nothing', async () => {
    const { handshakeId } = await startHandshake(
      tenantB,
      adminB,
      `login-b-${run}`,
    );

    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantB, adminB))
      .send({ handshakeId, pageId: pageFail, channels: ['messenger'] })
      .expect(403);

    expect(await storedRow(pageFail)).toBeUndefined();
  });

  it('a page connected to another tenant is a 409 even when this login manages it, and Meta is not called', async () => {
    const { handshakeId } = await startHandshake(
      tenantB,
      adminB,
      `login-b-${run}`,
    );
    const subscribeCalls = fakeGraph.subscribeApp.mock.calls.length;

    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantB, adminB))
      .send({ handshakeId, pageId: pageA, channels: ['messenger'] })
      .expect(409);

    expect(fakeGraph.subscribeApp.mock.calls.length).toBe(subscribeCalls);
    expect((await storedRow(pageA))?.tenantId).toBe(tenantA);
    await expect(credentials.getCredentials(pageA)).resolves.toMatchObject({
      pageAccessToken: `page-token-a-${run}`,
    });
  });

  it("another tenant's or user's handshake is a 410, same as an expired one", async () => {
    const { handshakeId } = await startHandshake(
      tenantA,
      adminA,
      `login-a-${run}`,
    );
    const body = { handshakeId, pageId: pageA, channels: ['messenger'] };

    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantB, adminB))
      .send(body)
      .expect(410);
    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantA, randomUUID()))
      .send(body)
      .expect(410);

    await redis.del(`meta-connect:handshake:${handshakeId}`);
    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantA, adminA))
      .send(body)
      .expect(410);
  });

  it('a failed subscribed_apps call is a 502 and stores nothing', async () => {
    const { handshakeId } = await startHandshake(
      tenantA,
      adminA,
      `login-a-${run}`,
    );

    const response = await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantA, adminA))
      .send({ handshakeId, pageId: pageFail, channels: ['messenger'] })
      .expect(502);

    expect(response.text).not.toContain('page-token');
    expect(await storedRow(pageFail)).toBeUndefined();
  });

  it('BREAKING: the pre-T4 body with a raw pageAccessToken is refused with 400', async () => {
    await request(server())
      .post('/channels/meta')
      .set('Authorization', bearer(tenantB, adminB))
      .send({
        channel: 'messenger',
        channelAccountId: pageB,
        pageId: pageB,
        pageAccessToken: 'browser-supplied-token',
      })
      .expect(400);

    expect(await storedRow(pageB)).toBeUndefined();
  });

  it('T7 linkage: a deauthorize for the connecting Meta user finds the channels T4 stored', async () => {
    const affected = await credentials.markReconnectRequiredForMetaUser(
      metaUserA,
      'test deauthorize',
    );

    expect(affected.map((row) => row.channelAccountId).sort()).toEqual(
      [igA, pageA].sort(),
    );
  });
});
