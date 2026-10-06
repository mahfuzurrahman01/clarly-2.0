// Gulf T4 (D4): the server-side Messenger/Instagram connect handshake.
//
// The REAL MetaConnectService over a fake MetaGraphClient, a fake
// credentials store and an in-memory handshake store. What this proves is
// the security property D4 exists for: a page token only ever comes from
// Meta's own `/me/accounts` answer for the logged-in user, so a page that
// user does not manage cannot be connected (the page-squat regression), and
// nothing is stored unless Meta accepted the webhook subscription.
import type { AppLoggerService } from '../core';
import {
  MetaGraphError,
  type GraphManagedPage,
  type MetaGraphClient,
} from '../meta-graph/meta-graph.module';
import type {
  HandshakeOwner,
  MetaConnectHandshake,
  MetaConnectHandshakeStore,
} from './meta-connect-handshake.store';
import {
  META_PAGE_SUBSCRIBED_FIELDS,
  MetaConnectService,
} from './meta-connect.service';
import type { SocialChannelCredentialsService } from './social-channel-credentials.service';
import {
  MetaConnectHandshakeExpiredError,
  MetaInstagramNotLinkedError,
  MetaLoginTokenRejectedError,
  MetaPageNotManagedError,
  SocialChannelOwnedByAnotherTenantError,
} from './social-channel.errors';

const SHORT_TOKEN = 'SHORT_LIVED_USER_TOKEN';
const LONG_TOKEN = 'LONG_LIVED_USER_TOKEN';
const OWNER: HandshakeOwner = { tenantId: 'tenant-a', userId: 'user-a' };
const EXPIRES = new Date('2026-11-18T10:00:00Z');

const PAGE_WITH_IG: GraphManagedPage = {
  id: 'PAGE_1',
  name: 'Shop One',
  accessToken: 'PAGE_TOKEN_1',
  instagram: { id: 'IG_1', username: 'shop.one' },
};
const PAGE_NO_IG: GraphManagedPage = {
  id: 'PAGE_2',
  name: 'Shop Two',
  accessToken: 'PAGE_TOKEN_2',
  instagram: null,
};

function inMemoryHandshakes() {
  const records = new Map<string, MetaConnectHandshake>();
  let counter = 0;
  const store = {
    save: jest.fn((handshake: MetaConnectHandshake) => {
      counter += 1;
      const handshakeId = `hs-${counter}`;
      records.set(handshakeId, handshake);
      return Promise.resolve({
        handshakeId,
        expiresAt: new Date('2026-09-19T10:15:00Z'),
      });
    }),
    load: jest.fn((handshakeId: string, owner: HandshakeOwner) => {
      const record = records.get(handshakeId);
      if (
        !record ||
        record.tenantId !== owner.tenantId ||
        record.userId !== owner.userId
      ) {
        return Promise.resolve(null);
      }
      return Promise.resolve(record);
    }),
  };
  return { store, records };
}

function makeHarness(
  options: {
    pages?: GraphManagedPage[];
    owners?: Record<string, string>;
  } = {},
) {
  const graph = {
    exchangeLongLivedUserToken: jest.fn().mockResolvedValue({
      accessToken: LONG_TOKEN,
      expiresInSeconds: 5_184_000,
    }),
    getMe: jest.fn().mockResolvedValue({ id: 'META_USER_1' }),
    listPages: jest
      .fn()
      .mockResolvedValue(options.pages ?? [PAGE_WITH_IG, PAGE_NO_IG]),
    subscribeApp: jest.fn().mockResolvedValue(undefined),
    inspectToken: jest
      .fn()
      .mockResolvedValue({ valid: true, expiresAt: EXPIRES }),
  };
  const owners = options.owners ?? {};
  const credentials = {
    findOwnerTenantId: jest.fn((accountId: string) =>
      Promise.resolve(owners[accountId] ?? null),
    ),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const handshakes = inMemoryHandshakes();

  const service = new MetaConnectService(
    graph as unknown as MetaGraphClient,
    handshakes.store as unknown as MetaConnectHandshakeStore,
    credentials as unknown as SocialChannelCredentialsService,
    logger as unknown as AppLoggerService,
  );

  return { service, graph, credentials, logger, handshakes };
}

async function startedHandshake(harness: ReturnType<typeof makeHarness>) {
  return harness.service.startHandshake({
    ...OWNER,
    userAccessToken: SHORT_TOKEN,
  });
}

function allLoggedText(logger: ReturnType<typeof makeHarness>['logger']) {
  return JSON.stringify([
    logger.log.mock.calls,
    logger.warn.mock.calls,
    logger.error.mock.calls,
  ]);
}

describe('MetaConnectService', () => {
  describe('startHandshake (step A)', () => {
    it('exchanges the short-lived token, reads /me and /me/accounts with the LONG-lived one', async () => {
      const harness = makeHarness();

      await startedHandshake(harness);

      expect(harness.graph.exchangeLongLivedUserToken).toHaveBeenCalledWith({
        userAccessToken: SHORT_TOKEN,
      });
      expect(harness.graph.getMe).toHaveBeenCalledWith(LONG_TOKEN);
      expect(harness.graph.listPages).toHaveBeenCalledWith(LONG_TOKEN);
    });

    it('returns the pages and linked IG accounts WITHOUT any token', async () => {
      const harness = makeHarness();

      const result = await startedHandshake(harness);

      expect(result).toEqual({
        handshakeId: 'hs-1',
        expiresAt: new Date('2026-09-19T10:15:00Z'),
        pages: [
          {
            id: 'PAGE_1',
            name: 'Shop One',
            instagram: { id: 'IG_1', username: 'shop.one' },
          },
          { id: 'PAGE_2', name: 'Shop Two', instagram: null },
        ],
      });
      const serialized = JSON.stringify(result);
      for (const secret of [
        SHORT_TOKEN,
        LONG_TOKEN,
        'PAGE_TOKEN_1',
        'PAGE_TOKEN_2',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });

    it("keeps Meta's page list, the long-lived token and the /me id server-side, bound to tenant + user", async () => {
      const harness = makeHarness();

      await startedHandshake(harness);

      expect(harness.handshakes.store.save).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        userId: 'user-a',
        metaUserId: 'META_USER_1',
        userAccessToken: LONG_TOKEN,
        pages: [PAGE_WITH_IG, PAGE_NO_IG],
      });
    });

    it('maps a token Meta rejects to MetaLoginTokenRejectedError and stores nothing', async () => {
      const harness = makeHarness();
      harness.graph.exchangeLongLivedUserToken.mockRejectedValue(
        new MetaGraphError(400, 190, 463, 'Session has expired'),
      );

      await expect(startedHandshake(harness)).rejects.toBeInstanceOf(
        MetaLoginTokenRejectedError,
      );
      expect(harness.handshakes.store.save).not.toHaveBeenCalled();
    });

    it('lets a transient Graph failure propagate as a MetaGraphError', async () => {
      const harness = makeHarness();
      harness.graph.listPages.mockRejectedValue(
        new MetaGraphError(500, 2, null, 'Service temporarily unavailable'),
      );

      await expect(startedHandshake(harness)).rejects.toBeInstanceOf(
        MetaGraphError,
      );
      expect(harness.handshakes.store.save).not.toHaveBeenCalled();
    });

    it('never logs a token', async () => {
      const harness = makeHarness();
      await startedHandshake(harness);
      const logged = allLoggedText(harness.logger);
      for (const secret of [SHORT_TOKEN, LONG_TOKEN, 'PAGE_TOKEN_1']) {
        expect(logged).not.toContain(secret);
      }
    });
  });

  describe('connect (step B)', () => {
    it('subscribes the page with its Meta-issued token, then stores both channels with the user token and the /me id', async () => {
      const harness = makeHarness();
      const { handshakeId } = await startedHandshake(harness);

      await harness.service.connect({
        ...OWNER,
        handshakeId,
        pageId: 'PAGE_1',
        channels: ['messenger', 'instagram'],
      });

      expect(harness.graph.subscribeApp).toHaveBeenCalledTimes(1);
      expect(harness.graph.subscribeApp).toHaveBeenCalledWith({
        pageId: 'PAGE_1',
        pageAccessToken: 'PAGE_TOKEN_1',
        subscribedFields: META_PAGE_SUBSCRIBED_FIELDS,
      });
      // Gulf T8: page comments (F23) arrive on the `feed` field.
      expect(META_PAGE_SUBSCRIBED_FIELDS).toContain('feed');
      expect(harness.graph.inspectToken).toHaveBeenCalledWith('PAGE_TOKEN_1');

      const common = {
        tenantId: 'tenant-a',
        pageId: 'PAGE_1',
        credentials: {
          pageAccessToken: 'PAGE_TOKEN_1',
          userAccessToken: LONG_TOKEN,
        },
        tokenExpiresAt: EXPIRES,
        connectedByMetaUserId: 'META_USER_1',
      };
      expect(harness.credentials.upsert).toHaveBeenCalledWith({
        ...common,
        channel: 'messenger',
        channelAccountId: 'PAGE_1',
        displayName: 'Shop One',
      });
      expect(harness.credentials.upsert).toHaveBeenCalledWith({
        ...common,
        channel: 'instagram',
        channelAccountId: 'IG_1',
        displayName: 'shop.one',
      });
    });

    it('SQUAT REGRESSION: a page the logged-in user does not manage is refused and nothing is called', async () => {
      const harness = makeHarness();
      const { handshakeId } = await startedHandshake(harness);

      await expect(
        harness.service.connect({
          ...OWNER,
          handshakeId,
          pageId: 'SOMEONE_ELSES_PAGE',
          channels: ['messenger'],
        }),
      ).rejects.toBeInstanceOf(MetaPageNotManagedError);

      expect(harness.graph.subscribeApp).not.toHaveBeenCalled();
      expect(harness.credentials.upsert).not.toHaveBeenCalled();
    });

    it('refuses a page already connected to another tenant BEFORE touching Meta', async () => {
      const harness = makeHarness({ owners: { PAGE_1: 'tenant-b' } });
      const { handshakeId } = await startedHandshake(harness);

      await expect(
        harness.service.connect({
          ...OWNER,
          handshakeId,
          pageId: 'PAGE_1',
          channels: ['messenger'],
        }),
      ).rejects.toBeInstanceOf(SocialChannelOwnedByAnotherTenantError);

      expect(harness.graph.subscribeApp).not.toHaveBeenCalled();
      expect(harness.credentials.upsert).not.toHaveBeenCalled();
    });

    it('refuses when the linked IG account belongs to another tenant, even if the page does not', async () => {
      const harness = makeHarness({ owners: { IG_1: 'tenant-b' } });
      const { handshakeId } = await startedHandshake(harness);

      await expect(
        harness.service.connect({
          ...OWNER,
          handshakeId,
          pageId: 'PAGE_1',
          channels: ['messenger', 'instagram'],
        }),
      ).rejects.toBeInstanceOf(SocialChannelOwnedByAnotherTenantError);
      expect(harness.credentials.upsert).not.toHaveBeenCalled();
    });

    it('allows re-connecting a page this tenant already owns', async () => {
      const harness = makeHarness({ owners: { PAGE_1: 'tenant-a' } });
      const { handshakeId } = await startedHandshake(harness);

      await harness.service.connect({
        ...OWNER,
        handshakeId,
        pageId: 'PAGE_1',
        channels: ['messenger'],
      });

      expect(harness.credentials.upsert).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown or expired handshake', async () => {
      const harness = makeHarness();

      await expect(
        harness.service.connect({
          ...OWNER,
          handshakeId: 'hs-never-issued',
          pageId: 'PAGE_1',
          channels: ['messenger'],
        }),
      ).rejects.toBeInstanceOf(MetaConnectHandshakeExpiredError);
      expect(harness.graph.subscribeApp).not.toHaveBeenCalled();
    });

    it("rejects another tenant's handshake the same way as an expired one", async () => {
      const harness = makeHarness();
      const { handshakeId } = await startedHandshake(harness);

      await expect(
        harness.service.connect({
          tenantId: 'tenant-b',
          userId: 'user-b',
          handshakeId,
          pageId: 'PAGE_1',
          channels: ['messenger'],
        }),
      ).rejects.toBeInstanceOf(MetaConnectHandshakeExpiredError);
    });

    it('rejects Instagram for a page with no linked IG account, before subscribing', async () => {
      const harness = makeHarness();
      const { handshakeId } = await startedHandshake(harness);

      await expect(
        harness.service.connect({
          ...OWNER,
          handshakeId,
          pageId: 'PAGE_2',
          channels: ['instagram'],
        }),
      ).rejects.toBeInstanceOf(MetaInstagramNotLinkedError);
      expect(harness.graph.subscribeApp).not.toHaveBeenCalled();
    });

    it('stores NOTHING when subscribed_apps fails', async () => {
      const harness = makeHarness();
      harness.graph.subscribeApp.mockRejectedValue(
        new MetaGraphError(403, 200, null, 'Requires pages_manage_metadata'),
      );
      const { handshakeId } = await startedHandshake(harness);

      await expect(
        harness.service.connect({
          ...OWNER,
          handshakeId,
          pageId: 'PAGE_1',
          channels: ['messenger', 'instagram'],
        }),
      ).rejects.toBeInstanceOf(MetaGraphError);
      expect(harness.credentials.upsert).not.toHaveBeenCalled();
    });

    it('connects with a NULL expiry when debug_token fails', async () => {
      const harness = makeHarness();
      harness.graph.inspectToken.mockRejectedValue(new Error('network'));
      const { handshakeId } = await startedHandshake(harness);

      await harness.service.connect({
        ...OWNER,
        handshakeId,
        pageId: 'PAGE_1',
        channels: ['messenger'],
      });

      expect(harness.credentials.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ tokenExpiresAt: null }),
      );
    });

    it('falls back to the page name when the IG account has no username', async () => {
      const harness = makeHarness({
        pages: [{ ...PAGE_WITH_IG, instagram: { id: 'IG_1', username: null } }],
      });
      const { handshakeId } = await startedHandshake(harness);

      await harness.service.connect({
        ...OWNER,
        handshakeId,
        pageId: 'PAGE_1',
        channels: ['instagram'],
      });

      expect(harness.credentials.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'instagram',
          displayName: 'Shop One',
        }),
      );
    });

    it('never logs a token', async () => {
      const harness = makeHarness();
      const { handshakeId } = await startedHandshake(harness);
      await harness.service.connect({
        ...OWNER,
        handshakeId,
        pageId: 'PAGE_1',
        channels: ['messenger', 'instagram'],
      });

      const logged = allLoggedText(harness.logger);
      for (const secret of [SHORT_TOKEN, LONG_TOKEN, 'PAGE_TOKEN_1']) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
