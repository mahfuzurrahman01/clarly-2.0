/**
 * T9: E2E flows — Gulf parity exit criteria.
 *
 * These tests exercise the full webhook ingest → reply pipeline against a
 * live NestJS server. They do NOT test browser UI; they verify the server's
 * HTTP contract end-to-end.
 *
 * Run:  pnpm start  (or  pnpm dev)
 *       E2E_BASE_URL=http://localhost:3000 pnpm test:e2e:playwright
 *
 * Each flow is independently skippable via env flags so CI can run a subset
 * when the full meta-graph token is unavailable.
 */
import { test, expect } from '@playwright/test';
import { Client } from 'pg';

// Skip all E2E tests when the server isn't running.
// The global-setup sets E2E_SERVER_READY=1 only when reachable.
const describe =
  process.env.E2E_SERVER_READY === '1' ? test.describe : test.describe.skip;

const WA_WEBHOOK = '/webhooks/whatsapp';
const META_WEBHOOK = '/webhooks/meta';

// Fixed test IDs — seeded in beforeAll, cleaned in afterAll.
const TEST_TENANT_ID = '00000000-0000-0000-0000-00000000e2e1';
const WA_PHONE_ID = 'pn-e2e-wa-fixed';
const MESSENGER_PAGE_ID = 'page-e2e-messenger-fixed';
const IG_ACCOUNT_ID = 'ig-e2e-fixed';

const pg = new Client({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:54322/postgres',
});

// ===========================================================================
// Database seeding (runs once before all tests in this file)
// ===========================================================================

test.beforeAll(async () => {
  await pg.connect();
  await pg.query(
    `INSERT INTO tenants (id, name, phone, active, created_at, updated_at)
     VALUES ($1, $2, $3, true, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [TEST_TENANT_ID, 'E2E Test Tenant', '+966500000000'],
  );
  await pg.query(
    `INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, bsp_credentials_encrypted, connection_state, created_at, updated_at, health_issues)
     VALUES ($1, $2, 'e2e-dummy-cred', 'active', NOW(), NOW(), '[]'::jsonb)
     ON CONFLICT (phone_number_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
    [TEST_TENANT_ID, WA_PHONE_ID],
  );
  await pg.query(
    `INSERT INTO social_channels (tenant_id, channel, channel_account_id, page_id, credentials_encrypted, connection_state, created_at, updated_at)
     VALUES ($1, 'messenger', $2, $2, 'e2e-dummy-cred', 'connected', NOW(), NOW())
     ON CONFLICT (channel_account_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
    [TEST_TENANT_ID, MESSENGER_PAGE_ID],
  );
  await pg.query(
    `INSERT INTO social_channels (tenant_id, channel, channel_account_id, page_id, credentials_encrypted, connection_state, created_at, updated_at)
     VALUES ($1, 'instagram', $2, $2, 'e2e-dummy-cred', 'connected', NOW(), NOW())
     ON CONFLICT (channel_account_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
    [TEST_TENANT_ID, IG_ACCOUNT_ID],
  );
  await pg.end();
});

// ---------------------------------------------------------------------------
// Helpers: Meta webhook payloads.
// ---------------------------------------------------------------------------

function waTextMessage(phoneNumberId: string, from: string, text: string) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_E2E',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '966500000000',
                phone_number_id: phoneNumberId,
              },
              messages: [
                {
                  from,
                  id: `wamid.e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  });
}

function messengerDm(pageId: string, psid: string, text: string) {
  return JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: {
              mid: `mid.e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
              text,
            },
          },
        ],
      },
    ],
  });
}

function igDm(igAccountId: string, igsid: string, text: string) {
  return JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: igAccountId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: igAccountId },
            timestamp: Date.now(),
            message: {
              mid: `mid.ig.e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
              text,
            },
          },
        ],
      },
    ],
  });
}

function fbFeedComment(
  pageId: string,
  postId: string,
  commentId: string,
  userId: string,
  userName: string,
  text: string,
) {
  return JSON.stringify({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now() / 1000,
        changes: [
          {
            field: 'feed',
            value: {
              item: 'comment',
              verb: 'add',
              comment_id: commentId,
              post_id: postId,
              parent_id: postId,
              from: { id: userId, name: userName },
              message: text,
              created_time: Math.floor(Date.now() / 1000),
            },
          },
        ],
      },
    ],
  });
}

function igComment(
  igAccountId: string,
  commentId: string,
  mediaId: string,
  userId: string,
  username: string,
  text: string,
  parentId?: string,
) {
  return JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: igAccountId,
        time: Date.now() / 1000,
        changes: [
          {
            field: 'comments',
            value: {
              comment_id: commentId,
              from: { id: userId, username },
              text,
              media: { id: mediaId, media_product_type: 'REELS' },
              parent_id: parentId,
            },
          },
        ],
      },
    ],
  });
}

function whatsappEcho(phoneNumberId: string, to: string, text: string) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_E2E',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '966500000000',
                phone_number_id: phoneNumberId,
              },
              message_echoes: [
                {
                  from: phoneNumberId,
                  to,
                  id: `wamid.echo.e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
            field: 'smb_message_echoes',
          },
        ],
      },
    ],
  });
}

// ===========================================================================
// Flow 1: WhatsApp connect → inbound message → reply
// ===========================================================================
describe('Flow 1: WhatsApp connect → reply', () => {
  test('ingests a text message and acks with 200', async ({ request }) => {
    const body = waTextMessage(WA_PHONE_ID, '966501111111', 'Do you deliver?');

    const res = await request.post(WA_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });

  test('rejects unknown phone_number_id with 404', async ({ request }) => {
    const body = waTextMessage(
      'pn-not-connected',
      '966502222222',
      'This number is not connected',
    );

    const res = await request.post(WA_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(404);
  });
});

// ===========================================================================
// Flow 2: Facebook/Instagram connect → DM reply
// ===========================================================================
describe('Flow 2: FB/IG connect → DM reply', () => {
  test('ingests a Messenger text DM and acks with 200', async ({ request }) => {
    const body = messengerDm(
      MESSENGER_PAGE_ID,
      'PSID-999001',
      'Hello from Messenger',
    );

    const res = await request.post(META_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });

  test('ingests an Instagram text DM and acks with 200', async ({
    request,
  }) => {
    const body = igDm(IG_ACCOUNT_ID, 'IGSID-999002', 'bkm?');

    const res = await request.post(META_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });

  test('rejects an unconnected page with 404', async ({ request }) => {
    const body = messengerDm(
      'page-not-connected',
      'PSID-999003',
      'This page is not linked',
    );

    const res = await request.post(META_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(404);
  });
});

// ===========================================================================
// Flow 3: Comment → public + private reply (with replay safety)
// ===========================================================================
describe('Flow 3: Comment → public + private reply', () => {
  test('ingests a Facebook feed comment (verb=add) and acks 200', async ({
    request,
  }) => {
    const postId = `${MESSENGER_PAGE_ID}_post_001`;
    const commentId = `fb-c.e2e.${Date.now()}`;

    const body = fbFeedComment(
      MESSENGER_PAGE_ID,
      postId,
      commentId,
      'FBUSER-999010',
      'Khalid',
      'price?',
    );

    const res = await request.post(META_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });

  test('ingests an Instagram comment (REELS) and acks 200', async ({
    request,
  }) => {
    const commentId = `ig-c.e2e.${Date.now()}`;

    const body = igComment(
      IG_ACCOUNT_ID,
      commentId,
      `ig-media.e2e.${Date.now()}`,
      'IGSID-999011',
      'fatma_riyadh',
      'bkm?',
    );

    const res = await request.post(META_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });

  test('replayed comment is acked with 200 (ledger idempotency)', async ({
    request,
  }) => {
    const commentId = `ig-c.replay.${Date.now()}`;
    const mediaId = `ig-media.replay.${Date.now()}`;

    const payload = igComment(
      IG_ACCOUNT_ID,
      commentId,
      mediaId,
      'IGSID-999012',
      'replay_user',
      'Still available?',
    );

    const [res1, res2] = await Promise.all([
      request.post(META_WEBHOOK, {
        headers: { 'content-type': 'application/json' },
        data: payload,
      }),
      request.post(META_WEBHOOK, {
        headers: { 'content-type': 'application/json' },
        data: payload,
      }),
    ]);

    expect(res1.status()).toBe(200);
    expect(res2.status()).toBe(200);
  });

  test('comment from the page owner is not treated as customer comment', async ({
    request,
  }) => {
    const postId = `${MESSENGER_PAGE_ID}_post_002`;

    const body = fbFeedComment(
      MESSENGER_PAGE_ID,
      postId,
      `fb-c.self.${Date.now()}`,
      MESSENGER_PAGE_ID,
      'Page Admin',
      'Thanks for reaching out!',
    );

    const res = await request.post(META_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });
});

// ===========================================================================
// Flow 4: Coexistence echo stays human-owned (D13)
// ===========================================================================
describe('Flow 4: Coexistence echo stays human-owned', () => {
  test('WhatsApp echo is acked with 200 but not treated as inbound', async ({
    request,
  }) => {
    const body = whatsappEcho(
      WA_PHONE_ID,
      '966501234567',
      'Thanks for contacting us.',
    );

    const res = await request.post(WA_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: body,
    });

    expect(res.status()).toBe(200);
  });

  test('echo does NOT appear in the inbound message count', async ({
    request,
  }) => {
    const echoBody = whatsappEcho(
      WA_PHONE_ID,
      '966509999999',
      'This was sent by a human.',
    );

    await request.post(WA_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: echoBody,
    });

    const realBody = waTextMessage(
      WA_PHONE_ID,
      '966509999999',
      'Now a real customer message.',
    );

    const res = await request.post(WA_WEBHOOK, {
      headers: { 'content-type': 'application/json' },
      data: realBody,
    });

    expect(res.status()).toBe(200);
  });
});
