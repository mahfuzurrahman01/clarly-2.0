// The one spec that stubs `fetch` for Graph traffic: every other caller
// injects a fake (or, for the WhatsApp adapter's wire-level spec, this real
// client over a stubbed fetch).
import type { AppConfigService } from '../core';
import { MetaGraphClient } from './meta-graph.client';
import { MetaGraphError } from './meta-graph.error';

const TOKEN = 'EAAG-secret-token';

function makeConfig(overrides: Partial<AppConfigService> = {}) {
  return {
    metaGraphBaseUrl: 'https://graph.facebook.com',
    metaGraphVersion: 'v21.0',
    bspRequestTimeoutMs: 7000,
    metaAppId: 'APP_ID',
    metaAppSecret: 'app-secret-value',
    ...overrides,
  } as AppConfigService;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

async function caught(promise: Promise<unknown>): Promise<MetaGraphError> {
  try {
    await promise;
  } catch (error) {
    return error as MetaGraphError;
  }
  throw new Error('expected the call to reject');
}

describe('MetaGraphClient', () => {
  const originalFetch = global.fetch;
  let client: MetaGraphClient;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    client = new MetaGraphClient(makeConfig());
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('get', () => {
    it('GETs {base}/{version}/{path} with bearer auth and query params', async () => {
      fetchMock.mockResolvedValue(json(200, { data: [] }));

      await expect(
        client.get('WABA/message_templates', TOKEN, { limit: '200' }),
      ).resolves.toEqual({ data: [] });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/WABA/message_templates?limit=200',
      );
      expect(init.method).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it('tolerates a leading slash in the path', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      await client.get('/MEDIA_1', TOKEN);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://graph.facebook.com/v21.0/MEDIA_1',
      );
    });

    it('honours the configured base URL and version', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      const pinned = new MetaGraphClient(
        makeConfig({
          metaGraphBaseUrl: 'http://localhost:9999',
          metaGraphVersion: 'v23.0',
        }),
      );
      await pinned.get('X', TOKEN);
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v23.0/X');
    });

    it('returns null for an empty 2xx body', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 200 }));
      await expect(client.get('X', TOKEN)).resolves.toBeNull();
    });

    it('throws rather than guessing when a 2xx body is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
      const error = await caught(client.get('X', TOKEN));
      expect(error).toBeInstanceOf(MetaGraphError);
      expect(error.status).toBe(200);
      expect(error.message).toMatch(/non-JSON/);
    });
  });

  describe('post', () => {
    it('POSTs a JSON body with bearer auth and content type', async () => {
      fetchMock.mockResolvedValue(json(200, { id: '1' }));

      await expect(
        client.post('PN/messages', { to: 'x' }, TOKEN),
      ).resolves.toEqual({ id: '1' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v21.0/PN/messages');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      });
      expect(JSON.parse(init.body as string)).toEqual({ to: 'x' });
    });
  });

  describe('getBinary', () => {
    it('fetches an ABSOLUTE url with bearer auth and returns the bytes', async () => {
      fetchMock.mockResolvedValue(
        new Response(new Uint8Array([9, 8, 7]), { status: 200 }),
      );

      await expect(
        client.getBinary('https://lookaside.fbsbx.com/m?x=1', TOKEN),
      ).resolves.toEqual(Buffer.from([9, 8, 7]));

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://lookaside.fbsbx.com/m?x=1');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it('throws a MetaGraphError on a non-2xx download', async () => {
      fetchMock.mockResolvedValue(
        json(401, { error: { message: 'bad token', code: 190 } }),
      );
      const error = await caught(client.getBinary('https://x/y', TOKEN));
      expect(error).toBeInstanceOf(MetaGraphError);
      expect(error.status).toBe(401);
      expect(error.isTokenInvalid).toBe(true);
    });
  });

  describe('timeouts', () => {
    it('attaches an AbortSignal.timeout of the configured duration to every request', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      // A fresh Response per call: a body can only be read once.
      fetchMock.mockImplementation(() =>
        Promise.resolve(json(200, { message_id: 'm' })),
      );

      await client.get('X', TOKEN);
      await client.post('X', {}, TOKEN);
      await client.getBinary('https://x/y', TOKEN);
      await client.sendMessage({
        pageId: 'PAGE',
        pageAccessToken: TOKEN,
        recipientId: 'R',
        text: 't',
      });

      expect(timeout).toHaveBeenCalledTimes(4);
      expect(timeout).toHaveBeenCalledWith(7000);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
      timeout.mockRestore();
    });

    it('lets an abort (timeout) propagate as-is rather than dressing it up as a Graph error', async () => {
      const abort = new DOMException(
        'The operation timed out.',
        'TimeoutError',
      );
      fetchMock.mockRejectedValue(abort);
      await expect(client.get('X', TOKEN)).rejects.toBe(abort);
    });
  });

  describe('error envelope', () => {
    it("parses Meta's code, subcode and message", async () => {
      fetchMock.mockResolvedValue(
        json(400, {
          error: {
            message: 'Error validating access token: Session has expired',
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
          },
        }),
      );

      const error = await caught(client.get('X', TOKEN));

      expect(error).toBeInstanceOf(MetaGraphError);
      expect(error.status).toBe(400);
      expect(error.code).toBe(190);
      expect(error.subcode).toBe(463);
      expect(error.message).toBe(
        'Error validating access token: Session has expired',
      );
    });

    it('falls back to status + truncated body when there is no envelope', async () => {
      fetchMock.mockResolvedValue(
        new Response('x'.repeat(2000), { status: 503 }),
      );
      const error = await caught(client.get('X', TOKEN));
      expect(error.code).toBeNull();
      expect(error.subcode).toBeNull();
      expect(error.message).toMatch(/^Meta Graph API returned HTTP 503: x+$/);
      expect(error.message.length).toBeLessThan(600);
    });

    it('never puts the bearer token in the message, even when echoed', async () => {
      fetchMock.mockResolvedValue(
        json(400, { error: { message: `token ${TOKEN} is not valid` } }),
      );
      const error = await caught(client.post('X', {}, TOKEN));
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).toContain('[redacted]');
    });

    it('never puts query-string credentials in the message either', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          'echo client_secret=app-secret-value fb_exchange_token=USER_TOKEN',
          { status: 500 },
        ),
      );
      const error = await caught(
        client.exchangeLongLivedUserToken({ userAccessToken: 'USER_TOKEN' }),
      );
      expect(error.message).not.toContain('app-secret-value');
      expect(error.message).not.toContain('USER_TOKEN');
    });
  });

  describe('MetaGraphError.isTokenInvalid', () => {
    it.each([
      [190, true],
      [102, true],
      [10, true],
      [200, true],
      [299, true],
      [4, false],
      [100, false],
      [300, false],
      [null, false],
    ])('code %p -> %p', (code, expected) => {
      expect(new MetaGraphError(400, code, null, 'm').isTokenInvalid).toBe(
        expected,
      );
    });
  });

  describe('MetaGraphError.withOperation', () => {
    it('returns a NEW error naming the operation, keeping status/code/subcode', () => {
      const original = new MetaGraphError(401, 190, 463, 'Session expired');
      const named = original.withOperation('MetaCloudAdapter: send');

      expect(named).not.toBe(original);
      expect(named).toBeInstanceOf(MetaGraphError);
      expect(named.message).toBe(
        'MetaCloudAdapter: send failed with HTTP 401: Session expired',
      );
      expect([named.status, named.code, named.subcode]).toEqual([
        401, 190, 463,
      ]);
      expect(named.isTokenInvalid).toBe(true);
      expect(original.message).toBe('Session expired');
    });
  });

  // The social methods predate T1; these pin their wire shape so the move to
  // the shared module is provably behaviour-identical.
  describe('social channel methods', () => {
    it('sendMessage posts the Send API body to /{page-id}/messages', async () => {
      fetchMock.mockResolvedValue(json(200, { message_id: 'mid.1' }));

      await expect(
        client.sendMessage({
          pageId: 'PAGE',
          pageAccessToken: TOKEN,
          recipientId: 'PSID',
          text: 'hi',
          tag: 'HUMAN_AGENT',
        }),
      ).resolves.toEqual({ messageId: 'mid.1' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v21.0/PAGE/messages');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
      expect(JSON.parse(init.body as string)).toEqual({
        recipient: { id: 'PSID' },
        message: { text: 'hi' },
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
      });
    });

    it('exchangeLongLivedUserToken authenticates in the query string with META_APP_SECRET, no bearer header', async () => {
      fetchMock.mockResolvedValue(
        json(200, { access_token: 'LL', expires_in: 5000 }),
      );

      await expect(
        client.exchangeLongLivedUserToken({ userAccessToken: 'U' }),
      ).resolves.toEqual({ accessToken: 'LL', expiresInSeconds: 5000 });

      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/v21.0/oauth/access_token');
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        grant_type: 'fb_exchange_token',
        client_id: 'APP_ID',
        client_secret: 'app-secret-value',
        fb_exchange_token: 'U',
      });
      expect(init.headers).toBeUndefined();
    });

    it('fetchPageAccessToken reads /{page-id}?fields=access_token', async () => {
      fetchMock.mockResolvedValue(json(200, { access_token: 'PAGE_TOKEN' }));

      await expect(
        client.fetchPageAccessToken({ userAccessToken: 'U', pageId: 'PAGE' }),
      ).resolves.toBe('PAGE_TOKEN');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://graph.facebook.com/v21.0/PAGE?fields=access_token&access_token=U',
      );
    });

    it('inspectToken uses the app-token form and maps expires_at=0 to null', async () => {
      fetchMock.mockResolvedValue(
        json(200, { data: { is_valid: true, expires_at: 0 } }),
      );

      await expect(client.inspectToken('T')).resolves.toEqual({
        valid: true,
        expiresAt: null,
      });
      const parsed = new URL(fetchMock.mock.calls[0][0]);
      expect(parsed.searchParams.get('access_token')).toBe(
        'APP_ID|app-secret-value',
      );
      expect(parsed.searchParams.get('input_token')).toBe('T');
    });
  });

  // Gulf T3 (D3). Response shapes recorded from Meta's Embedded Signup docs
  // ("Onboarding business customers as a Tech Provider" and "Manage
  // accounts": the debug_token granular_scopes sample).
  describe('embedded signup methods', () => {
    it('exchangeEmbeddedSignupCode sends client_id, client_secret and code in the query string only', async () => {
      fetchMock.mockResolvedValue(
        json(200, { access_token: 'BUSINESS_TOKEN', token_type: 'bearer' }),
      );

      await expect(
        client.exchangeEmbeddedSignupCode('CODE_1'),
      ).resolves.toEqual({
        accessToken: 'BUSINESS_TOKEN',
        expiresInSeconds: null,
      });
      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/v21.0/oauth/access_token');
      expect(parsed.searchParams.get('client_id')).toBe('APP_ID');
      expect(parsed.searchParams.get('client_secret')).toBe('app-secret-value');
      expect(parsed.searchParams.get('code')).toBe('CODE_1');
      expect(parsed.searchParams.has('grant_type')).toBe(false);
      expect(parsed.searchParams.has('redirect_uri')).toBe(false);
      expect(init.headers).toBeUndefined();
    });

    it('exchangeEmbeddedSignupCode throws when Meta returns no token', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      const error = await caught(client.exchangeEmbeddedSignupCode('C'));
      expect(error).toBeInstanceOf(MetaGraphError);
      expect(error.message).toMatch(/no access_token/);
    });

    it('never leaks the code or app secret into a code-exchange error', async () => {
      fetchMock.mockResolvedValue(
        json(400, {
          error: {
            message:
              'This authorization code has been used. code=CODE_SECRET app-secret-value',
            type: 'OAuthException',
            code: 100,
            error_subcode: 36009,
          },
        }),
      );
      const error = await caught(
        client.exchangeEmbeddedSignupCode('CODE_SECRET'),
      );
      expect(error.status).toBe(400);
      expect(error.code).toBe(100);
      expect(error.subcode).toBe(36009);
      expect(error.message).not.toContain('CODE_SECRET');
      expect(error.message).not.toContain('app-secret-value');
    });

    it('inspectTokenScopes returns app_id and granular_scopes target ids', async () => {
      fetchMock.mockResolvedValue(
        json(200, {
          data: {
            app_id: 'APP_ID',
            type: 'SYSTEM_USER',
            application: 'Our App',
            user_id: '122100000000000001',
            is_valid: true,
            expires_at: 0,
            scopes: [
              'whatsapp_business_management',
              'whatsapp_business_messaging',
            ],
            granular_scopes: [
              {
                scope: 'whatsapp_business_management',
                target_ids: ['102289599326934', '101569239400667'],
              },
              {
                scope: 'whatsapp_business_messaging',
                target_ids: ['102289599326934'],
              },
              { scope: 'business_management' },
            ],
          },
        }),
      );

      await expect(client.inspectTokenScopes('BT')).resolves.toEqual({
        valid: true,
        appId: 'APP_ID',
        userId: '122100000000000001',
        granularScopes: [
          {
            scope: 'whatsapp_business_management',
            targetIds: ['102289599326934', '101569239400667'],
          },
          {
            scope: 'whatsapp_business_messaging',
            targetIds: ['102289599326934'],
          },
          { scope: 'business_management', targetIds: [] },
        ],
      });
      const parsed = new URL(fetchMock.mock.calls[0][0]);
      expect(parsed.searchParams.get('input_token')).toBe('BT');
      expect(parsed.searchParams.get('access_token')).toBe(
        'APP_ID|app-secret-value',
      );
    });

    it('inspectTokenScopes treats a missing data block as invalid with no scopes', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      await expect(client.inspectTokenScopes('BT')).resolves.toEqual({
        valid: false,
        appId: null,
        userId: null,
        granularScopes: [],
      });
    });
  });

  describe('social connect handshake methods (Gulf T4)', () => {
    const USER_TOKEN = 'EAAG-long-lived-user-token';

    it('getMe reads /me?fields=id with bearer auth, never a query-string token', async () => {
      fetchMock.mockResolvedValue(json(200, { id: '1234567890' }));

      await expect(client.getMe(USER_TOKEN)).resolves.toEqual({
        id: '1234567890',
      });

      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/v21.0/me');
      expect(parsed.searchParams.get('fields')).toBe('id');
      expect(parsed.searchParams.get('access_token')).toBeNull();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${USER_TOKEN}`,
      );
    });

    it('getMe throws when Meta returns no id', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      const error = await caught(client.getMe(USER_TOKEN));
      expect(error).toBeInstanceOf(MetaGraphError);
      expect(error.message).not.toContain(USER_TOKEN);
    });

    it('listPages requests the page + linked IG fields and maps them', async () => {
      fetchMock.mockResolvedValue(
        json(200, {
          data: [
            {
              id: 'PAGE_1',
              name: 'Shop One',
              access_token: 'PAGE_TOKEN_1',
              instagram_business_account: { id: 'IG_1', username: 'shop.one' },
            },
            { id: 'PAGE_2', name: 'Shop Two', access_token: 'PAGE_TOKEN_2' },
          ],
          paging: { cursors: { before: 'B', after: 'A' } },
        }),
      );

      await expect(client.listPages(USER_TOKEN)).resolves.toEqual([
        {
          id: 'PAGE_1',
          name: 'Shop One',
          accessToken: 'PAGE_TOKEN_1',
          instagram: { id: 'IG_1', username: 'shop.one' },
        },
        {
          id: 'PAGE_2',
          name: 'Shop Two',
          accessToken: 'PAGE_TOKEN_2',
          instagram: null,
        },
      ]);

      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/v21.0/me/accounts');
      expect(parsed.searchParams.get('fields')).toBe(
        'id,name,access_token,instagram_business_account{id,username}',
      );
      expect(parsed.searchParams.get('access_token')).toBeNull();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${USER_TOKEN}`,
      );
      // No `paging.next` means no second request, even though a cursor exists.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('listPages follows the `after` cursor while Meta reports a next page', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(200, {
            data: [{ id: 'P1', name: 'One', access_token: 'T1' }],
            paging: {
              cursors: { after: 'CURSOR_1' },
              // Meta's `next` embeds the token in its query string; the
              // client must NOT follow it verbatim.
              next: 'https://graph.facebook.com/v21.0/me/accounts?access_token=LEAK&after=CURSOR_1',
            },
          }),
        )
        .mockResolvedValueOnce(
          json(200, {
            data: [{ id: 'P2', name: 'Two', access_token: 'T2' }],
            paging: { cursors: { after: 'CURSOR_2' } },
          }),
        );

      const pages = await client.listPages(USER_TOKEN);

      expect(pages.map((page) => page.id)).toEqual(['P1', 'P2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = new URL(fetchMock.mock.calls[1][0]);
      expect(second.searchParams.get('after')).toBe('CURSOR_1');
      expect(second.searchParams.get('access_token')).toBeNull();
    });

    it('listPages skips entries without an id or page token rather than inventing one', async () => {
      fetchMock.mockResolvedValue(
        json(200, {
          data: [
            { id: 'P1', name: 'No token' },
            { name: 'No id', access_token: 'T' },
            { id: 'P3', access_token: 'T3' },
          ],
        }),
      );

      await expect(client.listPages(USER_TOKEN)).resolves.toEqual([
        { id: 'P3', name: null, accessToken: 'T3', instagram: null },
      ]);
    });

    it('listPages stops after a bounded number of pages', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          json(200, {
            data: [{ id: 'P', name: 'x', access_token: 'T' }],
            paging: { cursors: { after: 'C' }, next: 'https://x/next' },
          }),
        ),
      );

      await client.listPages(USER_TOKEN);

      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
    });

    it('subscribeApp POSTs subscribed_fields to /{page-id}/subscribed_apps with the PAGE token', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true }));

      await client.subscribeApp({
        pageId: 'PAGE_1',
        pageAccessToken: 'PAGE_TOKEN_1',
        subscribedFields: ['messages', 'messaging_postbacks'],
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/PAGE_1/subscribed_apps',
      );
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        subscribed_fields: 'messages,messaging_postbacks',
      });
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer PAGE_TOKEN_1',
      );
    });

    it('subscribeApp throws when Meta does not report success', async () => {
      fetchMock.mockResolvedValue(json(200, { success: false }));
      await expect(
        client.subscribeApp({
          pageId: 'PAGE_1',
          pageAccessToken: 'PAGE_TOKEN_1',
          subscribedFields: ['messages'],
        }),
      ).rejects.toBeInstanceOf(MetaGraphError);
    });

    it('subscribeApp surfaces a Graph error with the page token redacted', async () => {
      fetchMock.mockResolvedValue(
        json(403, { error: { message: 'Bad token PAGE_TOKEN_1', code: 200 } }),
      );
      const error = await caught(
        client.subscribeApp({
          pageId: 'PAGE_1',
          pageAccessToken: 'PAGE_TOKEN_1',
          subscribedFields: ['messages'],
        }),
      );
      expect(error.status).toBe(403);
      expect(error.message).not.toContain('PAGE_TOKEN_1');
    });
  });

  describe('comment methods (Gulf T8)', () => {
    const lastCall = () => {
      const [url, init] = fetchMock.mock.calls[0];
      return {
        url,
        method: init.method,
        body: JSON.parse(init.body as string) as unknown,
        auth: (init.headers as Record<string, string>).Authorization,
      };
    };

    it('replyToComment posts to /{comment-id}/comments on Facebook', async () => {
      fetchMock.mockResolvedValue(json(200, { id: 'reply-1' }));
      await expect(
        client.replyToComment({
          surface: 'facebook',
          commentId: 'C_1',
          message: 'Sent you a DM',
          pageAccessToken: 'PAGE_TOKEN_1',
        }),
      ).resolves.toEqual({ id: 'reply-1' });
      expect(lastCall()).toEqual({
        url: 'https://graph.facebook.com/v21.0/C_1/comments',
        method: 'POST',
        body: { message: 'Sent you a DM' },
        auth: 'Bearer PAGE_TOKEN_1',
      });
    });

    it('replyToComment posts to /{ig-comment-id}/replies on Instagram', async () => {
      fetchMock.mockResolvedValue(json(200, { id: 'reply-2' }));
      await client.replyToComment({
        surface: 'instagram',
        commentId: 'IGC_1',
        message: 'hi',
        pageAccessToken: 'PAGE_TOKEN_1',
      });
      expect(lastCall().url).toBe(
        'https://graph.facebook.com/v21.0/IGC_1/replies',
      );
    });

    it('replyToComment throws when Meta returns no id', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      await expect(
        client.replyToComment({
          surface: 'facebook',
          commentId: 'C_1',
          message: 'x',
          pageAccessToken: 'T',
        }),
      ).rejects.toBeInstanceOf(MetaGraphError);
    });

    it('hideComment sends is_hidden on Facebook and hide on Instagram', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true }));
      await client.hideComment({
        surface: 'facebook',
        commentId: 'C_1',
        pageAccessToken: 'T',
      });
      expect(lastCall()).toMatchObject({
        url: 'https://graph.facebook.com/v21.0/C_1',
        body: { is_hidden: true },
      });

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(json(200, { success: true }));
      await client.hideComment({
        surface: 'instagram',
        commentId: 'IGC_1',
        pageAccessToken: 'T',
      });
      expect(lastCall()).toMatchObject({
        url: 'https://graph.facebook.com/v21.0/IGC_1',
        body: { hide: true },
      });
    });

    it('hideComment throws when Meta does not confirm', async () => {
      fetchMock.mockResolvedValue(json(200, { success: false }));
      await expect(
        client.hideComment({
          surface: 'facebook',
          commentId: 'C_1',
          pageAccessToken: 'T',
        }),
      ).rejects.toBeInstanceOf(MetaGraphError);
    });

    it('sendPrivateReply addresses the comment through the page Send API', async () => {
      fetchMock.mockResolvedValue(
        json(200, { recipient_id: 'PSID_9', message_id: 'mid.9' }),
      );
      await expect(
        client.sendPrivateReply({
          pageId: 'PAGE_1',
          commentId: 'C_1',
          text: 'Here are the details',
          pageAccessToken: 'PAGE_TOKEN_1',
        }),
      ).resolves.toEqual({ recipientId: 'PSID_9', messageId: 'mid.9' });
      expect(lastCall()).toEqual({
        url: 'https://graph.facebook.com/v21.0/PAGE_1/messages',
        method: 'POST',
        body: {
          recipient: { comment_id: 'C_1' },
          message: { text: 'Here are the details' },
        },
        auth: 'Bearer PAGE_TOKEN_1',
      });
    });

    it('sendPrivateReply throws when Meta omits the recipient or message id', async () => {
      fetchMock.mockResolvedValue(json(200, { message_id: 'mid.9' }));
      await expect(
        client.sendPrivateReply({
          pageId: 'PAGE_1',
          commentId: 'C_1',
          text: 'x',
          pageAccessToken: 'T',
        }),
      ).rejects.toBeInstanceOf(MetaGraphError);
    });
  });

  describe('MetaGraphError.isRateLimited (Gulf T8)', () => {
    it.each([
      [429, null, true],
      [400, 4, true],
      [400, 17, true],
      [400, 32, true],
      [400, 613, true],
      [400, 80002, true],
      [400, 190, false],
      [400, 100, false],
      [500, null, false],
    ])('HTTP %p code %p -> %p', (status, code, expected) => {
      expect(new MetaGraphError(status, code, null, 'm').isRateLimited).toBe(
        expected,
      );
    });
  });
});
