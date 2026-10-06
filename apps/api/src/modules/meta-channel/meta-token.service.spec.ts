// Feature 16, the 2026-09-06 eng-review requirement: token refresh and
// expiry.
//
// These are the tests that stand in for what cannot be verified without Meta
// Tech Provider approval. Every Graph call is behind `MetaGraphClient`, so a
// fake client lets the REAL MetaTokenService run its real decision logic —
// what counts as due, what a refusal means versus a network blip, what gets
// written back. What remains unproven is only whether Meta's live responses
// match the shapes asserted here.
import { MetaGraphError } from '../meta-graph/meta-graph.module';
import type { MetaGraphClient } from '../meta-graph/meta-graph.module';
import {
  MetaTokenService,
  TOKEN_REFRESH_WINDOW_MS,
} from './meta-token.service';
import type { SocialChannelCredentialsService } from './social-channel-credentials.service';
import type { SocialChannelState } from './social-channel-credentials.service';
import { SocialChannelReconnectRequiredError } from './social-channel.errors';
import type { AppLoggerService } from '../core';

const ACCOUNT = 'page-1';
const NOW = new Date('2026-09-06T12:00:00Z');

function makeState(
  overrides: Partial<SocialChannelState> = {},
): SocialChannelState {
  return {
    id: 'sc-1',
    tenantId: 'tenant-a',
    channel: 'messenger',
    channelAccountId: ACCOUNT,
    pageId: ACCOUNT,
    tokenExpiresAt: new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000),
    connectionState: 'connected',
    connectionError: null,
    ...overrides,
  };
}

function makeHarness(
  options: {
    state?: SocialChannelState;
    credentials?: { pageAccessToken: string; userAccessToken?: string };
  } = {},
) {
  const getState = jest.fn().mockResolvedValue(options.state ?? makeState());
  const getCredentials = jest.fn().mockResolvedValue(
    options.credentials ?? {
      pageAccessToken: 'page-token-old',
      userAccessToken: 'user-token-old',
    },
  );
  const recordRefreshedToken = jest.fn().mockResolvedValue(undefined);
  const markReconnectRequired = jest.fn().mockResolvedValue(undefined);
  const listExpiringBefore = jest.fn().mockResolvedValue([]);

  const exchangeLongLivedUserToken = jest.fn().mockResolvedValue({
    accessToken: 'user-token-new',
    expiresInSeconds: 60 * 24 * 60 * 60,
  });
  const fetchPageAccessToken = jest.fn().mockResolvedValue('page-token-new');

  const service = new MetaTokenService(
    {
      exchangeLongLivedUserToken,
      fetchPageAccessToken,
    } as unknown as MetaGraphClient,
    {
      getState,
      getCredentials,
      recordRefreshedToken,
      markReconnectRequired,
      listExpiringBefore,
    } as unknown as SocialChannelCredentialsService,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService,
  );

  return {
    service,
    getCredentials,
    recordRefreshedToken,
    markReconnectRequired,
    listExpiringBefore,
    exchangeLongLivedUserToken,
    fetchPageAccessToken,
  };
}

describe('MetaTokenService.needsRefresh()', () => {
  const { service } = makeHarness();

  it('is due once the token is inside the refresh window', () => {
    const expires = new Date(NOW.getTime() + TOKEN_REFRESH_WINDOW_MS - 1000);
    expect(
      service.needsRefresh(makeState({ tokenExpiresAt: expires }), NOW),
    ).toBe(true);
  });

  it('is not due while the token is comfortably ahead of the window', () => {
    const expires = new Date(NOW.getTime() + TOKEN_REFRESH_WINDOW_MS + 60_000);
    expect(
      service.needsRefresh(makeState({ tokenExpiresAt: expires }), NOW),
    ).toBe(false);
  });

  it('treats a NULL expiry as "nothing to pre-empt", never as expired', () => {
    // Meta reports no expiry for system-user tokens. Reading null as
    // "overdue" would put every such channel into a permanent refresh loop
    // against a token that cannot be refreshed and does not need to be.
    expect(service.needsRefresh(makeState({ tokenExpiresAt: null }), NOW)).toBe(
      false,
    );
  });
});

describe('MetaTokenService.ensureFreshToken()', () => {
  it('returns the stored token untouched when it is nowhere near expiry', async () => {
    const { service, exchangeLongLivedUserToken } = makeHarness();

    await expect(service.ensureFreshToken(ACCOUNT)).resolves.toBe(
      'page-token-old',
    );
    expect(exchangeLongLivedUserToken).not.toHaveBeenCalled();
  });

  it('refreshes a token nearing expiry automatically, before it is used', async () => {
    // Feature 16's exit criterion, first half: "a page/IG token nearing
    // expiry is refreshed automatically".
    const nearlyExpired = new Date(Date.now() + 60 * 60 * 1000);
    const harness = makeHarness({
      state: makeState({ tokenExpiresAt: nearlyExpired }),
    });
    harness.getCredentials
      .mockResolvedValueOnce({
        pageAccessToken: 'page-token-old',
        userAccessToken: 'user-token-old',
      })
      .mockResolvedValueOnce({
        pageAccessToken: 'page-token-new',
        userAccessToken: 'user-token-new',
      });

    await expect(harness.service.ensureFreshToken(ACCOUNT)).resolves.toBe(
      'page-token-new',
    );

    // The user token is extended FIRST and the page token re-read with it:
    // page tokens have no refresh grant of their own.
    expect(harness.exchangeLongLivedUserToken).toHaveBeenCalledWith({
      userAccessToken: 'user-token-old',
    });
    expect(harness.fetchPageAccessToken).toHaveBeenCalledWith({
      userAccessToken: 'user-token-new',
      pageId: ACCOUNT,
    });
    expect(harness.recordRefreshedToken).toHaveBeenCalledWith(
      ACCOUNT,
      { pageAccessToken: 'page-token-new', userAccessToken: 'user-token-new' },
      expect.any(Date),
    );
    expect(harness.markReconnectRequired).not.toHaveBeenCalled();
  });

  it('degrades this ONE channel to reconnect_required when Meta refuses the refresh', async () => {
    // Feature 16's exit criterion, second half: "a token that fails to
    // refresh degrades that one channel to a clear reconnect-needed state
    // rather than silently dropping messages."
    const harness = makeHarness({
      state: makeState({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
    });
    harness.exchangeLongLivedUserToken.mockRejectedValue(
      new MetaGraphError(400, 190, 463, 'Session has expired'),
    );

    await expect(
      harness.service.ensureFreshToken(ACCOUNT),
    ).rejects.toBeInstanceOf(SocialChannelReconnectRequiredError);
    expect(harness.markReconnectRequired).toHaveBeenCalledWith(
      ACCOUNT,
      expect.stringContaining('Reconnect the channel'),
    );
  });

  it('does NOT degrade a channel over a transient Graph failure', async () => {
    // A 500 or a timeout is not a dead token. Degrading here would cost a
    // tenant their channel over a blip and demand a pointless re-consent.
    const harness = makeHarness({
      state: makeState({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
    });
    harness.exchangeLongLivedUserToken.mockRejectedValue(
      new MetaGraphError(503, null, null, 'temporarily unavailable'),
    );

    // The current token has not expired yet, so it is still used — the
    // customer gets an answer and the sweep retries later.
    await expect(harness.service.ensureFreshToken(ACCOUNT)).resolves.toBe(
      'page-token-old',
    );
    expect(harness.markReconnectRequired).not.toHaveBeenCalled();
  });

  it('refuses to send on an already-degraded channel without re-hammering Graph', async () => {
    const harness = makeHarness({
      state: makeState({
        connectionState: 'reconnect_required',
        connectionError: 'Meta rejected the stored credentials',
      }),
    });

    await expect(
      harness.service.ensureFreshToken(ACCOUNT),
    ).rejects.toBeInstanceOf(SocialChannelReconnectRequiredError);
    expect(harness.exchangeLongLivedUserToken).not.toHaveBeenCalled();
  });

  it('degrades a channel that has no user token to refresh from', async () => {
    const harness = makeHarness({
      state: makeState({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
      credentials: { pageAccessToken: 'page-token-old' },
    });

    await expect(
      harness.service.ensureFreshToken(ACCOUNT),
    ).rejects.toBeInstanceOf(SocialChannelReconnectRequiredError);
    expect(harness.markReconnectRequired).toHaveBeenCalledWith(
      ACCOUNT,
      expect.stringContaining('cannot be renewed automatically'),
    );
  });
});

describe('MetaTokenService.refreshExpiringChannels() (the quiet-channel sweep)', () => {
  it('refreshes every due channel and reports per-channel outcomes', async () => {
    const harness = makeHarness();
    harness.listExpiringBefore.mockResolvedValue([
      makeState({ channelAccountId: 'page-1', pageId: 'page-1' }),
      makeState({
        channelAccountId: 'ig-1',
        pageId: 'page-2',
        channel: 'instagram',
      }),
    ]);

    const outcomes = await harness.service.refreshExpiringChannels(NOW);

    expect(outcomes).toEqual([
      { channelAccountId: 'page-1', status: 'refreshed' },
      { channelAccountId: 'ig-1', status: 'refreshed' },
    ]);
  });

  it('does not re-attempt a channel already marked reconnect_required', async () => {
    // It is already degraded and already reported; retrying every sweep is a
    // permanent, pointless load against Graph that changes nothing.
    const harness = makeHarness();
    harness.listExpiringBefore.mockResolvedValue([
      makeState({
        connectionState: 'reconnect_required',
        connectionError: 'gone',
      }),
    ]);

    const outcomes = await harness.service.refreshExpiringChannels(NOW);

    expect(outcomes).toEqual([
      {
        channelAccountId: ACCOUNT,
        status: 'reconnect_required',
        detail: 'gone',
      },
    ]);
    expect(harness.exchangeLongLivedUserToken).not.toHaveBeenCalled();
  });

  it('keeps sweeping after one channel throws — one tenant must not abort the pass', async () => {
    const harness = makeHarness();
    harness.listExpiringBefore.mockResolvedValue([
      makeState({ channelAccountId: 'broken' }),
      makeState({ channelAccountId: 'fine' }),
    ]);
    harness.getCredentials
      .mockRejectedValueOnce(new Error('decryption failed'))
      .mockResolvedValue({
        pageAccessToken: 'page-token-old',
        userAccessToken: 'user-token-old',
      });

    const outcomes = await harness.service.refreshExpiringChannels(NOW);

    expect(outcomes[0]).toMatchObject({
      channelAccountId: 'broken',
      status: 'deferred',
    });
    expect(outcomes[1]).toMatchObject({
      channelAccountId: 'fine',
      status: 'refreshed',
    });
  });
});
