// Gulf T7 (D7): Meta's Deauthorize and Data Deletion Request callbacks,
// end to end over HTTP against real Postgres + Redis.
//
// What only a database can prove, and so is proven here:
//   - Deauthorize degrades EVERY channel the named Meta user connected —
//     across tenants, since one Facebook user can admin pages for several
//     workspaces — and not one row connected by anyone else (cross-tenant and
//     same-tenant isolation);
//   - Data deletion leaves no token behind for that user, drops the link to
//     them, and is idempotent: the same signed_request re-delivered returns
//     the same confirmation code, and a second request for the same user
//     completes with nothing left to delete;
//   - a forged request changes nothing.
//
// Requires real Postgres + Redis (apps/api/.env / docker-compose.yml); runs
// via `npm run test:integration`. META_SOCIAL_APP_SECRET / META_APP_SECRET and
// API_PUBLIC_BASE_URL are defaulted below when the environment has none.
import { createHmac, randomUUID } from 'node:crypto';

process.env.META_SOCIAL_APP_SECRET ??=
  process.env.META_APP_SECRET ?? 'integration-meta-app-secret';
process.env.API_PUBLIC_BASE_URL ??= 'https://api.integration.test';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { SocialChannelCredentialsService } from '../../src/modules/meta-channel/social-channel-credentials.service';
import { hashMetaUserId } from '../../src/modules/meta-graph/meta-user-id-hash';
import {
  metaDataDeletionRequests,
  socialChannels,
  tenants,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { PrivacyModule } from '../../src/modules/privacy/privacy.module';
import { BspCredentialsEncryptionService } from '../../src/modules/whatsapp/bsp-credentials-encryption.service';

interface DeletionCallbackBody {
  url: string;
  confirmation_code: string;
}

describe('Meta privacy callbacks (Gulf T7 / D7)', () => {
  let app: INestApplication;
  let persistence: PersistenceService;
  let credentials: SocialChannelCredentialsService;
  let encryption: BspCredentialsEncryptionService;
  let secret: string;
  const server = (): Server => app.getHttpServer() as Server;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  // Realistic ASIDs, unique per run so parallel/previous runs never collide.
  const userU = `${Date.now()}1`;
  const userV = `${Date.now()}2`;
  const id = (label: string) => `${label}-${randomUUID()}`;
  const aPageByU = id('a-page-u');
  const bIgByU = id('b-ig-u');
  const bPageByV = id('b-page-v');
  const aPageNoUser = id('a-page-legacy');
  const all = [aPageByU, bIgByU, bPageByV, aPageNoUser];
  // Gulf T5: WhatsApp numbers connected through Embedded Signup by U / V /
  // before T5 (no user recorded).
  const waByU = id('wa-u');
  const waByV = id('wa-v');
  const waLegacy = id('wa-legacy');
  const allWa = [waByU, waByV, waLegacy];

  async function waRowsById() {
    const rows = await persistence.runAdminQuery((db) =>
      db
        .select()
        .from(whatsappNumbers)
        .where(inArray(whatsappNumbers.phoneNumberId, allWa)),
    );
    return new Map(rows.map((r) => [r.phoneNumberId, r]));
  }

  function sign(userId: string, issuedAt: number, key = secret): string {
    const payload = Buffer.from(
      JSON.stringify({
        algorithm: 'HMAC-SHA256',
        issued_at: issuedAt,
        user_id: userId,
      }),
    ).toString('base64url');
    const sig = createHmac('sha256', key).update(payload).digest('base64url');
    return `${sig}.${payload}`;
  }

  async function rowsById() {
    const rows = await persistence.runAdminQuery((db) =>
      db
        .select()
        .from(socialChannels)
        .where(inArray(socialChannels.channelAccountId, all)),
    );
    return new Map(rows.map((r) => [r.channelAccountId, r]));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, PrivacyModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    persistence = moduleRef.get(PersistenceService);
    credentials = moduleRef.get(SocialChannelCredentialsService);
    encryption = moduleRef.get(BspCredentialsEncryptionService);
    secret = moduleRef.get(AppConfigService).metaAppSecret;

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values([
        { id: tenantA, name: 'Privacy Tenant A' },
        { id: tenantB, name: 'Privacy Tenant B' },
      ]),
    );

    const connect = (
      tenantId: string,
      channel: 'messenger' | 'instagram',
      channelAccountId: string,
      metaUserId?: string,
    ) =>
      credentials.upsert({
        tenantId,
        channel,
        channelAccountId,
        pageId: channelAccountId,
        displayName: null,
        credentials: {
          pageAccessToken: `page-token-${channelAccountId}`,
          userAccessToken: `user-token-${channelAccountId}`,
        },
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        ...(metaUserId ? { connectedByMetaUserId: metaUserId } : {}),
      });

    await connect(tenantA, 'messenger', aPageByU, userU);
    await connect(tenantB, 'instagram', bIgByU, userU);
    await connect(tenantB, 'messenger', bPageByV, userV);
    await connect(tenantA, 'messenger', aPageNoUser);

    await persistence.runAdminQuery((db) =>
      db.insert(whatsappNumbers).values([
        {
          tenantId: tenantA,
          phoneNumberId: waByU,
          bspCredentialsEncrypted: encryption.encrypt({ accessToken: 'a' }),
          connectedByMetaUserHash: hashMetaUserId(userU),
        },
        {
          tenantId: tenantB,
          phoneNumberId: waByV,
          bspCredentialsEncrypted: encryption.encrypt({ accessToken: 'b' }),
          connectedByMetaUserHash: hashMetaUserId(userV),
        },
        {
          tenantId: tenantA,
          phoneNumberId: waLegacy,
          bspCredentialsEncrypted: encryption.encrypt({ accessToken: 'c' }),
        },
      ]),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB])),
    );
    await app.close();
  });

  it('stores the connecting Meta user only as a hash', async () => {
    const rows = await rowsById();
    expect(rows.get(aPageByU)?.connectedByMetaUserHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(JSON.stringify([...rows.values()])).not.toContain(userU);
  });

  it('rejects a forged deauthorize and changes nothing', async () => {
    await request(server())
      .post('/meta/deauthorize')
      .type('form')
      .send({ signed_request: sign(userU, 1, 'not-the-app-secret') })
      .expect(401);

    const rows = await rowsById();
    for (const accountId of all) {
      expect(rows.get(accountId)?.connectionState).toBe('connected');
    }
  });

  it("deauthorize degrades every channel user U connected, in both tenants, and nobody else's", async () => {
    await request(server())
      .post('/meta/deauthorize')
      .type('form')
      .send({ signed_request: sign(userU, Math.floor(Date.now() / 1000)) })
      .expect(200, { received: true });

    const rows = await rowsById();
    expect(rows.get(aPageByU)?.connectionState).toBe('reconnect_required');
    expect(rows.get(bIgByU)?.connectionState).toBe('reconnect_required');
    expect(rows.get(aPageByU)?.connectionError).toMatch(/removed this app/);
    // Same tenant as a U channel, different user / no user: untouched.
    expect(rows.get(bPageByV)?.connectionState).toBe('connected');
    expect(rows.get(aPageNoUser)?.connectionState).toBe('connected');
    // Deauthorize does not erase: credentials survive for diagnosis.
    expect(
      encryption.decrypt(rows.get(aPageByU)!.credentialsEncrypted),
    ).toMatchObject({ pageAccessToken: `page-token-${aPageByU}` });
  });

  it('Gulf T5: that deauthorize also moved the WhatsApp number U connected to reconnect_required, and no other number', async () => {
    const rows = await waRowsById();
    expect(rows.get(waByU)?.connectionState).toBe('reconnect_required');
    expect(rows.get(waByU)?.connectionError).toMatch(/removed this app/);
    expect(rows.get(waByV)?.connectionState).toBe('active');
    expect(rows.get(waLegacy)?.connectionState).toBe('active');
  });

  it("data deletion erases every token user U granted, returns Meta's { url, confirmation_code }, and the status page reports completed", async () => {
    const signed = sign(userU, Math.floor(Date.now() / 1000));

    const res = await request(server())
      .post('/meta/data-deletion')
      .type('form')
      .send({ signed_request: signed })
      .expect(200);

    const body = res.body as DeletionCallbackBody;
    const code = body.confirmation_code;
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(body.url).toBe(
      `${process.env.API_PUBLIC_BASE_URL?.replace(/\/+$/, '')}/meta/data-deletion/status/${code}`,
    );

    const rows = await rowsById();
    for (const accountId of [aPageByU, bIgByU]) {
      const row = rows.get(accountId)!;
      expect(encryption.decrypt(row.credentialsEncrypted)).toEqual({});
      expect(row.connectedByMetaUserHash).toBeNull();
      expect(row.connectionState).toBe('reconnect_required');
      expect(row.tokenExpiresAt).toBeNull();
    }
    // V's channel and the legacy row keep their tokens.
    expect(
      encryption.decrypt(rows.get(bPageByV)!.credentialsEncrypted),
    ).toMatchObject({ pageAccessToken: `page-token-${bPageByV}` });
    expect(rows.get(bPageByV)?.connectedByMetaUserHash).not.toBeNull();
    expect(
      encryption.decrypt(rows.get(aPageNoUser)!.credentialsEncrypted),
    ).toMatchObject({ pageAccessToken: `page-token-${aPageNoUser}` });

    const status = await request(server())
      .get(`/meta/data-deletion/status/${code}`)
      .set('Accept', 'application/json')
      .expect(200);
    expect(status.body).toMatchObject({
      confirmation_code: code,
      status: 'completed',
    });
    expect(Object.keys(status.body as object).sort()).toEqual(
      ['completed_at', 'confirmation_code', 'requested_at', 'status'].sort(),
    );

    // Meta re-delivering the same request: same code, still one row.
    const replay = await request(server())
      .post('/meta/data-deletion')
      .type('form')
      .send({ signed_request: signed })
      .expect(200);
    expect((replay.body as DeletionCallbackBody).confirmation_code).toBe(code);

    // The same user asking again: a new request, nothing left to delete.
    const again = await request(server())
      .post('/meta/data-deletion')
      .type('form')
      .send({ signed_request: sign(userU, Math.floor(Date.now() / 1000) + 1) })
      .expect(200);
    const againCode = (again.body as DeletionCallbackBody).confirmation_code;
    expect(againCode).not.toBe(code);

    const requests = await persistence.runAdminQuery((db) =>
      db
        .select()
        .from(metaDataDeletionRequests)
        .where(
          inArray(metaDataDeletionRequests.confirmationCode, [code, againCode]),
        ),
    );
    expect(
      requests
        .map((r) => [r.status, r.socialChannelsScrubbed])
        .sort((a, b) => Number(b[1]) - Number(a[1])),
    ).toEqual([
      ['completed', 2],
      ['completed', 0],
    ]);
    expect(JSON.stringify(requests)).not.toContain(userU);

    await persistence.runAdminQuery((db) =>
      db
        .delete(metaDataDeletionRequests)
        .where(
          inArray(metaDataDeletionRequests.confirmationCode, [code, againCode]),
        ),
    );
  });

  it('404s an unknown confirmation code', async () => {
    await request(server())
      .get(`/meta/data-deletion/status/${'f'.repeat(32)}`)
      .expect(404);
  });

  it('a later reconnect restores the channel (the documented recovery path)', async () => {
    await credentials.upsert({
      tenantId: tenantA,
      channel: 'messenger',
      channelAccountId: aPageByU,
      pageId: aPageByU,
      displayName: null,
      credentials: { pageAccessToken: 'fresh-page-token' },
      tokenExpiresAt: null,
      connectedByMetaUserId: userU,
    });
    const row = (
      await persistence.runAdminQuery((db) =>
        db
          .select()
          .from(socialChannels)
          .where(eq(socialChannels.channelAccountId, aPageByU)),
      )
    )[0];
    expect(row.connectionState).toBe('connected');
    expect(row.connectedByMetaUserHash).not.toBeNull();
  });
});
