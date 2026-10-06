// Gulf T8 (F23; D6, D11, D15b) exit criteria, over HTTP against real Postgres
// + Redis + BullMQ. Only the edges are faked: the Graph client (no Meta app
// here), the page-token lookup, the classifier's model and the agent runtime.
//
//   1. a purchase-intent comment -> exactly one private + one public reply;
//   2. a replay of the same webhook -> still exactly one of each (D6 ledger);
//   3. spam is hidden, not answered;
//   4. our own comment is dropped (D6 own-echo);
//   5. the commenter answering the private reply lands in the inbox as a
//      normal conversation that starts with our private reply (D15b);
//   6. the tenant rules API: admin-only, validated, tenant-isolated;
//   7. the new tables are RLS-isolated.
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AgentRuntime } from '../../src/modules/agent/agent-runtime';
import type { AgentTurnResult } from '../../src/modules/agent/agent-turn.dto';
import { COMMENT_AUTOMATION_QUEUE } from '../../src/modules/comments/comment-automation.queue';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { LlmProvider } from '../../src/modules/llm/ports/llm-provider.port';
import { MetaTokenService } from '../../src/modules/meta-channel/meta-token.service';
import { MetaGraphClient } from '../../src/modules/meta-graph/meta-graph.module';
import {
  agentRuns,
  commentActions,
  commentEvents,
  commentPostRules,
  conversations,
  customerLabels,
  messages,
  plans,
  socialChannels,
  tenantPolicy,
  tenantSubscriptions,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RESPOND_PATH_QUEUE } from '../../src/modules/queue/queue.providers';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';

const ENV_OVERRIDES: Record<string, string> = {
  META_SOCIAL_CHANNELS_ENABLED: 'true',
  META_APP_ID: 'integration-t8-app',
  META_APP_SECRET: 'integration-t8-app-secret',
  META_VERIFY_TOKEN: 'integration-t8-verify',
  BSP_WEBHOOK_SIGNATURE_REQUIRED: 'true',
};

async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe('Comment automation (Gulf T8 exit criteria)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let app: INestApplication;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let jwtSecret: string;
  let appSecret: string;
  let commentQueue: Queue;
  let respondQueue: Queue;

  const run = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();
  const planId = randomUUID();
  const pageA = `t8-page-a-${run}`;
  const igA = `t8-ig-a-${run}`;
  const pageForIgA = `t8-page-ig-a-${run}`;
  const pageB = `t8-page-b-${run}`;
  const buyerPsid = `t8-psid-${run}`;

  let privateReplySeq = 0;
  const fakeGraph = {
    replyToComment: jest.fn(() =>
      Promise.resolve({ id: `reply-${randomUUID()}` }),
    ),
    sendPrivateReply: jest.fn(() => {
      privateReplySeq += 1;
      return Promise.resolve({
        recipientId: buyerPsid,
        messageId: `mid.private-${run}-${privateReplySeq}`,
      });
    }),
    hideComment: jest.fn(() => Promise.resolve()),
    sendMessage: jest.fn(() =>
      Promise.resolve({ messageId: `mid.answer-${randomUUID()}` }),
    ),
  };

  const fakeLlm = {
    complete: jest.fn(
      ({ messages: prompt }: { messages: { content: string }[] }) =>
        Promise.resolve({
          content: prompt[1]?.content.includes('idiot') ? 'abuse' : 'purchase',
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 1 },
        }),
    ),
    completeWithTools: jest.fn(),
    countTokens: jest.fn(() => Promise.resolve(10)),
    supportsVision: () => false,
  };

  const agentAnswer: AgentTurnResult = {
    answer: 'The black abaya is 250 SAR and ships in 2 days.',
    citedChunkIds: [],
    confidence: 0.92,
    escalate: false,
    escalationReason: null,
    escalationSource: null,
    isHallucination: false,
    promptVersion: 'test',
    telemetry: { inputTokens: 400, outputTokens: 30, latencyMs: 5, spans: {} },
  };
  const fakeRuntime = { respond: jest.fn(() => Promise.resolve(agentAnswer)) };

  const server = () => app.getHttpServer() as Server;

  function bearer(tenantId: string, userId: string, role = 'admin'): string {
    const now = Math.floor(Date.now() / 1000);
    return `Bearer ${jwt.sign(
      {
        sub: userId,
        role: 'authenticated',
        app_metadata: { tenant_id: tenantId, app_role: role },
        exp: now + 3600,
      },
      jwtSecret,
      { algorithm: 'HS256', noTimestamp: true },
    )}`;
  }

  function postWebhook(body: string) {
    const signature = createHmac('sha256', appSecret)
      .update(body)
      .digest('hex');
    return request(server())
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${signature}`)
      .send(body);
  }

  function feedWebhook(
    value: Record<string, unknown>,
    entryId = pageA,
  ): string {
    return JSON.stringify({
      object: 'page',
      entry: [
        {
          id: entryId,
          time: Math.floor(Date.now() / 1000),
          changes: [{ field: 'feed', value }],
        },
      ],
    });
  }

  function feedComment(
    commentId: string,
    message: string,
    fromId = `u-${run}`,
  ) {
    return {
      from: { id: fromId, name: 'Buyer' },
      post_id: `${pageA}_post-1`,
      comment_id: commentId,
      parent_id: `${pageA}_post-1`,
      message,
      created_time: Math.floor(Date.now() / 1000),
      item: 'comment',
      verb: 'add',
    };
  }

  // The comment tables are RLS-scoped (FORCE), so reads go through the
  // tenant's context like the app's own; runAdminQuery would see nothing.
  async function eventRow(commentId: string) {
    return tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(commentEvents)
          .where(eq(commentEvents.commentId, commentId)),
      tenantA,
    );
  }

  async function actionRows(commentId: string) {
    return tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(commentActions)
          .where(eq(commentActions.commentId, commentId)),
      tenantA,
    );
  }

  const settingsBody = {
    enabled: true,
    postScope: 'all',
    replyIntents: ['purchase', 'question'],
    keywordTriggers: ['بكم'],
    spamKeywords: ['free followers'],
    hideSpam: true,
    publicReplyTemplate: 'Sent you the details in DM 💬',
    hourlyReplyCapPerPost: 50,
    hourlyReplyCapPerTenant: 500,
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WebhookModule,
      ],
    })
      .overrideProvider(MetaGraphClient)
      .useValue(fakeGraph)
      .overrideProvider(MetaTokenService)
      .useValue({
        ensureFreshToken: jest.fn(() => Promise.resolve('PAGE_TOKEN')),
        refreshExpiringChannels: jest.fn(() => Promise.resolve([])),
      })
      .overrideProvider(LlmProvider)
      .useValue(fakeLlm)
      .overrideProvider(AgentRuntime)
      .useValue(fakeRuntime)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    const config = moduleRef.get(AppConfigService);
    jwtSecret = config.supabaseJwtSecret;
    appSecret = config.metaAppSecret;
    commentQueue = moduleRef.get(getQueueToken(COMMENT_AUTOMATION_QUEUE));
    respondQueue = moduleRef.get(getQueueToken(RESPOND_PATH_QUEUE));

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'T8 Tenant A' },
        { id: tenantB, name: 'T8 Tenant B' },
      ]),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(plans).values({
        id: planId,
        name: `T8 Plan ${run}`,
        stripePriceId: `price_t8_${run}`,
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      }),
    );
    for (const tenantId of [tenantA, tenantB]) {
      await tenantContext.withTenantTx(
        (tx) =>
          tx.insert(tenantSubscriptions).values({
            tenantId,
            planId,
            stripeCustomerId: `cus_${tenantId}`,
            stripeSubscriptionId: `sub_${tenantId}`,
            status: 'active',
          }),
        tenantId,
      );
      await tenantContext.withTenantTx(
        (tx) =>
          tx.insert(tenantPolicy).values({
            tenantId,
            confidenceThreshold: 0.5,
            forbiddenTopics: [],
            tonePersonaOverride: null,
            rerankEnabled: false,
          }),
        tenantId,
      );
    }
    await persistence.runAdminQuery((db) =>
      db.insert(socialChannels).values([
        {
          tenantId: tenantA,
          channel: 'messenger',
          channelAccountId: pageA,
          pageId: pageA,
          credentialsEncrypted: 'not-used-token-service-is-faked',
        },
        {
          tenantId: tenantA,
          channel: 'instagram',
          channelAccountId: igA,
          pageId: pageForIgA,
          credentialsEncrypted: 'not-used-token-service-is-faked',
        },
        {
          tenantId: tenantB,
          channel: 'messenger',
          channelAccountId: pageB,
          pageId: pageB,
          credentialsEncrypted: 'not-used-token-service-is-faked',
        },
      ]),
    );
  });

  afterAll(async () => {
    await commentQueue.obliterate({ force: true });
    await respondQueue.obliterate({ force: true });
    await persistence.runAdminQuery((db) =>
      db
        .delete(socialChannels)
        .where(inArray(socialChannels.tenantId, [tenantA, tenantB])),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(plans).where(eq(plans.id, planId)),
    );
    await app.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('tenant rules API', () => {
    it('is admin-only', async () => {
      await request(server()).get('/comment-automation/settings').expect(401);
      await request(server())
        .get('/comment-automation/settings')
        .set('Authorization', bearer(tenantA, adminA, 'agent'))
        .expect(403);
    });

    it('returns defaults (automation off) before anything is saved', async () => {
      const response = await request(server())
        .get('/comment-automation/settings')
        .set('Authorization', bearer(tenantA, adminA))
        .expect(200);
      expect(response.body).toMatchObject({
        enabled: false,
        postScope: 'all',
        replyIntents: ['purchase', 'question'],
        updatedAt: null,
      });
    });

    it('validates the body', async () => {
      await request(server())
        .put('/comment-automation/settings')
        .set('Authorization', bearer(tenantA, adminA))
        .send({ ...settingsBody, hourlyReplyCapPerPost: 0 })
        .expect(400);
      await request(server())
        .put('/comment-automation/settings')
        .set('Authorization', bearer(tenantA, adminA))
        .send({ ...settingsBody, replyIntents: ['complaint'] })
        .expect(400);
    });

    it('saves the settings', async () => {
      const response = await request(server())
        .put('/comment-automation/settings')
        .set('Authorization', bearer(tenantA, adminA))
        .send(settingsBody)
        .expect(200);
      expect(response.body).toMatchObject({ ...settingsBody });
      expect(typeof (response.body as { updatedAt: string }).updatedAt).toBe(
        'string',
      );
    });

    it('refuses a post rule for a page this workspace has not connected (another tenant’s page)', async () => {
      await request(server())
        .put('/comment-automation/posts')
        .set('Authorization', bearer(tenantA, adminA))
        .send({
          channelAccountId: pageB,
          postId: `${pageB}_1`,
          enabled: true,
          publicReplyTemplate: null,
        })
        .expect(404);
    });

    it('keeps post rules tenant-isolated', async () => {
      const created = await request(server())
        .put('/comment-automation/posts')
        .set('Authorization', bearer(tenantA, adminA))
        .send({
          channelAccountId: pageA,
          postId: `${pageA}_other-post`,
          enabled: false,
          publicReplyTemplate: null,
        })
        .expect(200);
      const ruleId = (created.body as { id: string }).id;

      const listB = await request(server())
        .get('/comment-automation/posts')
        .set('Authorization', bearer(tenantB, adminB))
        .expect(200);
      expect(listB.body).toEqual([]);

      await request(server())
        .delete(`/comment-automation/posts/${ruleId}`)
        .set('Authorization', bearer(tenantB, adminB))
        .expect(404);

      const listA = await request(server())
        .get('/comment-automation/posts')
        .set('Authorization', bearer(tenantA, adminA))
        .expect(200);
      expect(listA.body).toEqual([
        expect.objectContaining({
          id: ruleId,
          enabled: false,
          channel: 'messenger',
        }),
      ]);
    });
  });

  describe('webhook -> actions', () => {
    const purchaseComment = `t8-c-purchase-${run}`;

    it('a purchase-intent comment gets exactly one private and one public reply', async () => {
      const body = feedWebhook(
        feedComment(purchaseComment, 'how much is the black abaya?'),
      );
      await postWebhook(body).expect(200);

      const [event] = await waitFor(
        () => eventRow(purchaseComment),
        (rows) => rows[0]?.status === 'completed',
      );
      expect(event).toMatchObject({
        tenantId: tenantA,
        status: 'completed',
        intent: 'purchase',
        decision: 'reply',
        threadState: 'awaiting_reply',
        privateReplyRecipientId: buyerPsid,
        privateReplyText: agentAnswer.answer,
      });

      const actions = await actionRows(purchaseComment);
      expect(actions.map((a) => [a.action, a.status]).sort()).toEqual([
        ['private_reply', 'succeeded'],
        ['public_reply', 'succeeded'],
      ]);
      expect(fakeGraph.sendPrivateReply).toHaveBeenCalledTimes(1);
      expect(fakeGraph.sendPrivateReply).toHaveBeenCalledWith({
        pageId: pageA,
        commentId: purchaseComment,
        text: agentAnswer.answer,
        pageAccessToken: 'PAGE_TOKEN',
      });
      expect(fakeGraph.replyToComment).toHaveBeenCalledTimes(1);
      expect(fakeGraph.replyToComment).toHaveBeenCalledWith({
        surface: 'facebook',
        commentId: purchaseComment,
        message: settingsBody.publicReplyTemplate,
        pageAccessToken: 'PAGE_TOKEN',
      });

      // Counted against usage: one agent_runs row, no conversation yet.
      const runs = await tenantContext.withTenantTx(
        (tx) =>
          tx.select().from(agentRuns).where(eq(agentRuns.tenantId, tenantA)),
        tenantA,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0].conversationId).toBeNull();

      // D15b: nothing is opened until the customer answers.
      const threads = await tenantContext.withTenantTx(
        (tx) =>
          tx
            .select()
            .from(conversations)
            .where(eq(conversations.tenantId, tenantA)),
        tenantA,
      );
      expect(threads).toHaveLength(0);
    });

    it('a replay of the same webhook still produces exactly one of each (D6)', async () => {
      const body = feedWebhook(
        feedComment(purchaseComment, 'how much is the black abaya?'),
      );
      await postWebhook(body).expect(200);
      await postWebhook(body).expect(200);
      // Give any (wrongly) queued job time to run.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(await eventRow(purchaseComment)).toHaveLength(1);
      expect(fakeGraph.sendPrivateReply).toHaveBeenCalledTimes(1);
      expect(fakeGraph.replyToComment).toHaveBeenCalledTimes(1);
      expect(await actionRows(purchaseComment)).toHaveLength(2);
    });

    it('rejects an unsigned delivery before recording anything', async () => {
      const commentId = `t8-c-unsigned-${run}`;
      await request(server())
        .post('/webhooks/meta')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=deadbeef')
        .send(feedWebhook(feedComment(commentId, 'price?')))
        .expect(401);
      expect(await eventRow(commentId)).toHaveLength(0);
    });

    it('hides spam (keyword rule) and never answers it', async () => {
      const commentId = `t8-c-spam-${run}`;
      await postWebhook(
        feedWebhook(
          feedComment(commentId, 'get FREE followers now, price in bio'),
        ),
      ).expect(200);

      const [event] = await waitFor(
        () => eventRow(commentId),
        (rows) => rows[0]?.status === 'completed',
      );
      expect(event.decision).toBe('hide');
      expect(fakeGraph.hideComment).toHaveBeenCalledWith({
        surface: 'facebook',
        commentId,
        pageAccessToken: 'PAGE_TOKEN',
      });
      expect(
        (await actionRows(commentId)).map((a) => [a.action, a.status]),
      ).toEqual([['hide', 'succeeded']]);
      expect(fakeGraph.sendPrivateReply).toHaveBeenCalledTimes(1);
    });

    it('hides a comment the classifier calls abuse on Instagram, via the IG surface', async () => {
      const commentId = `t8-igc-abuse-${run}`;
      const body = JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: igA,
            time: Math.floor(Date.now() / 1000),
            changes: [
              {
                field: 'comments',
                value: {
                  comment_id: commentId,
                  from: { id: `igsid-${run}`, username: 'troll' },
                  text: 'you are an idiot',
                  media: { id: `media-${run}`, media_product_type: 'REELS' },
                },
              },
            ],
          },
        ],
      });
      await postWebhook(body).expect(200);
      await waitFor(
        () => eventRow(commentId),
        (rows) => rows[0]?.status === 'completed',
      );
      expect(fakeGraph.hideComment).toHaveBeenCalledWith({
        surface: 'instagram',
        commentId,
        pageAccessToken: 'PAGE_TOKEN',
      });
    });

    it('drops our own comments (D6 own-echo) and non-add verbs', async () => {
      const own = `t8-c-own-${run}`;
      const edited = `t8-c-edited-${run}`;
      await postWebhook(
        feedWebhook(feedComment(own, 'Sent you the details in DM 💬', pageA)),
      ).expect(200);
      await postWebhook(
        feedWebhook({ ...feedComment(edited, 'price?'), verb: 'edited' }),
      ).expect(200);
      expect(await eventRow(own)).toHaveLength(0);
      expect(await eventRow(edited)).toHaveLength(0);
    });

    it('the customer answering the private reply lands in the inbox, starting with our private reply (D15b)', async () => {
      const dmMid = `mid.buyer-${run}`;
      const dm = JSON.stringify({
        object: 'page',
        entry: [
          {
            id: pageA,
            time: Date.now(),
            messaging: [
              {
                sender: { id: buyerPsid },
                recipient: { id: pageA },
                timestamp: Date.now(),
                message: { mid: dmMid, text: 'yes please, size M' },
              },
            ],
          },
        ],
      });
      await postWebhook(dm).expect(200);

      const [event] = await eventRow(purchaseComment);
      expect(event.threadState).toBe('replied');
      expect(event.conversationId).toEqual(expect.any(String));

      // F18: the comment's purchase intent labels the new customer hot.
      const labels = await tenantContext.withTenantTx(
        (tx) =>
          tx
            .select()
            .from(customerLabels)
            .where(eq(customerLabels.tenantId, tenantA)),
        tenantA,
      );
      expect(labels.map((row) => row.agentLabel)).toContain('hot');

      // The normal respond path records the customer's message and answers
      // it on the same conversation.
      const transcript = await waitFor(
        () =>
          tenantContext.withTenantTx(
            (tx) =>
              tx
                .select({ role: messages.role, content: messages.content })
                .from(messages)
                .where(
                  and(
                    eq(messages.tenantId, tenantA),
                    eq(messages.conversationId, event.conversationId as string),
                  ),
                )
                .orderBy(messages.createdAt),
            tenantA,
          ),
        (rows) => rows.length >= 3,
      );
      expect(transcript.slice(0, 3)).toEqual([
        { role: 'assistant', content: agentAnswer.answer },
        { role: 'user', content: 'yes please, size M' },
        { role: 'assistant', content: agentAnswer.answer },
      ]);
    });
  });

  describe('row-level security', () => {
    it('another tenant sees none of the comment tables', async () => {
      const counts = await tenantContext.withTenantTx(
        async (tx) => ({
          events: (await tx.select().from(commentEvents)).length,
          actions: (await tx.select().from(commentActions)).length,
          rules: (await tx.select().from(commentPostRules)).length,
        }),
        tenantB,
      );
      expect(counts).toEqual({ events: 0, actions: 0, rules: 0 });
    });

    it('a raw SQL count under another tenant is zero too', async () => {
      const rows = await tenantContext.withTenantTx(
        (tx) => tx.execute(sql`select count(*)::int as n from comment_events`),
        tenantB,
      );
      expect(rows.rows[0]).toEqual({ n: 0 });
    });
  });
});
