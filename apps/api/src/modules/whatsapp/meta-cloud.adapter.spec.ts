import { createHmac } from 'node:crypto';
import type { AppConfigService, AppLoggerService } from '../core';
import {
  MetaGraphClient,
  MetaGraphError,
} from '../meta-graph/meta-graph.module';
import type { BspCredentialsService } from './bsp-credentials.service';
import { CONNECTION_REASONS } from './health/connection-state.policy';
import type { WhatsappNumberHealthStore } from './health/whatsapp-number-health.store';
import { MetaCloudAdapter } from './meta-cloud.adapter';

// The adapter is wired to a REAL MetaGraphClient over a stubbed `fetch`, not
// to a fake client: this spec is regression #2's guard (respond-path,
// template and media sends), so it asserts the exact wire request — URL,
// method, bearer header, body — that Meta receives, through the shared
// client that T1 moved these calls onto.

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'kayan-verify-token';

const getCredential = jest.fn();
const transitionByPhoneNumberId = jest.fn().mockResolvedValue([]);
const warn = jest.fn();
const logger = { warn } as unknown as AppLoggerService;

function makeConfig(overrides: Partial<AppConfigService> = {}) {
  return {
    metaGraphBaseUrl: 'https://graph.facebook.com',
    metaGraphVersion: 'v21.0',
    metaAppSecret: APP_SECRET,
    metaVerifyToken: VERIFY_TOKEN,
    bspWebhookSignatureRequired: true,
    bspRequestTimeoutMs: 10000,
    ...overrides,
  } as AppConfigService;
}

function makeAdapter(config: AppConfigService = makeConfig()) {
  getCredential.mockResolvedValue('EAAG-access-token');
  return new MetaCloudAdapter(
    config,
    { getCredential } as unknown as BspCredentialsService,
    logger,
    new MetaGraphClient(config),
    { transitionByPhoneNumberId } as unknown as WhatsappNumberHealthStore,
  );
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/** Meta signs as `sha256=<hex>` — the documented format. */
function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function inboundBody(): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '8801767425235',
                phone_number_id: '1195456503655549',
              },
              messages: [
                {
                  from: '8801813316904',
                  id: 'wamid.HBgM',
                  timestamp: '1755000000',
                  type: 'text',
                  text: { body: 'when does my order ship?' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('MetaCloudAdapter', () => {
  let adapter: MetaCloudAdapter;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = makeAdapter();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a valid X-Hub-Signature-256 keyed by the app secret', () => {
      const body = inboundBody();
      expect(
        adapter.verifyWebhookSignature(body, {
          'x-hub-signature-256': sign(body),
        }),
      ).toBe(true);
    });

    it('verifies against the RAW bytes, not a re-serialized object', () => {
      // The controller hands over req.rawBody as a Buffer; key order is not
      // guaranteed to survive a parse/stringify round trip.
      const body = inboundBody();
      expect(
        adapter.verifyWebhookSignature(Buffer.from(body), {
          'x-hub-signature-256': sign(body),
        }),
      ).toBe(true);
    });

    it('matches the header case-insensitively', () => {
      const body = inboundBody();
      expect(
        adapter.verifyWebhookSignature(body, {
          'X-Hub-Signature-256': sign(body),
        }),
      ).toBe(true);
    });

    it('rejects a body tampered with after signing', () => {
      const signature = sign(inboundBody());
      const tampered = inboundBody().replace('ship', 'refund');
      expect(
        adapter.verifyWebhookSignature(tampered, {
          'x-hub-signature-256': signature,
        }),
      ).toBe(false);
    });

    it('rejects a signature made with a different app secret', () => {
      const body = inboundBody();
      const forged = `sha256=${createHmac('sha256', 'not-the-secret')
        .update(body)
        .digest('hex')}`;
      expect(
        adapter.verifyWebhookSignature(body, {
          'x-hub-signature-256': forged,
        }),
      ).toBe(false);
    });

    it('fails closed when the header is absent', () => {
      expect(adapter.verifyWebhookSignature(inboundBody(), {})).toBe(false);
    });

    it('fails closed when no app secret is configured', () => {
      const unconfigured = makeAdapter(makeConfig({ metaAppSecret: '' }));
      const body = inboundBody();
      expect(
        unconfigured.verifyWebhookSignature(body, {
          'x-hub-signature-256': sign(body),
        }),
      ).toBe(false);
    });

    it('honours the dev-only bypass but warns that Meta always signs', () => {
      const bypassed = makeAdapter(
        makeConfig({ bspWebhookSignatureRequired: false, metaAppSecret: '' }),
      );

      expect(bypassed.verifyWebhookSignature(inboundBody(), {})).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Meta always signs'),
        'MetaCloudAdapter',
      );
    });
  });

  describe('verifySubscription', () => {
    it('echoes the challenge when mode and verify token match', () => {
      expect(
        adapter.verifySubscription({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        }),
      ).toBe('1158201444');
    });

    it('rejects a wrong verify token', () => {
      expect(
        adapter.verifySubscription({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'guessed',
          'hub.challenge': '1158201444',
        }),
      ).toBeNull();
    });

    it('rejects a mode other than subscribe', () => {
      expect(
        adapter.verifySubscription({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        }),
      ).toBeNull();
    });

    it('rejects an empty query', () => {
      expect(adapter.verifySubscription({})).toBeNull();
    });

    it('rejects when no verify token is configured, rather than matching undefined', () => {
      const unconfigured = makeAdapter(makeConfig({ metaVerifyToken: '' }));
      expect(
        unconfigured.verifySubscription({
          'hub.mode': 'subscribe',
          'hub.verify_token': '',
          'hub.challenge': 'x',
        }),
      ).toBeNull();
    });
  });

  describe('sendTextMessage', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      global.fetch = fetchMock;
    });

    it('posts to the Graph API with the phone number id in the PATH and a bearer token', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ messages: [{ id: 'wamid.S' }] }),
      );

      const result = await adapter.sendTextMessage({
        phoneNumberId: '1195456503655549',
        to: '8801813316904',
        body: 'It ships tomorrow.',
      });

      expect(result).toEqual({ bspMessageId: 'wamid.S' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/1195456503655549/messages',
      );
      expect(init.method).toBe('POST');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer EAAG-access-token',
      );
      expect(JSON.parse(init.body as string)).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '8801813316904',
        type: 'text',
        text: { body: 'It ships tomorrow.' },
      });
    });

    it('resolves the access token per phone number id, never a global token', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ messages: [{ id: 'wamid.S' }] }),
      );

      await adapter.sendTextMessage({
        phoneNumberId: '1195456503655549',
        to: 'x',
        body: 'y',
      });

      expect(getCredential).toHaveBeenCalledWith(
        '1195456503655549',
        'accessToken',
      );
    });

    it('honours a configured Graph version', async () => {
      fetchMock.mockResolvedValue(okResponse({ messages: [{ id: 'w' }] }));
      const pinned = makeAdapter(makeConfig({ metaGraphVersion: 'v23.0' }));

      await pinned.sendTextMessage({ phoneNumberId: 'P', to: 'x', body: 'y' });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://graph.facebook.com/v23.0/P/messages',
      );
    });

    it('throws with the status and Meta error envelope on failure', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(
          401,
          '{"error":{"message":"Invalid OAuth access token"}}',
        ),
      );

      await expect(
        adapter.sendTextMessage({ phoneNumberId: 'P', to: 'x', body: 'y' }),
      ).rejects.toThrow(
        /MetaCloudAdapter: send failed with HTTP 401.*Invalid OAuth access token/,
      );
    });

    // D5 needs this later: a dead WhatsApp token is now distinguishable from
    // a transient failure on the send path, same as on the social channels.
    it('surfaces a code-190 rejection as a token-invalid MetaGraphError', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(
          401,
          '{"error":{"message":"Error validating access token","code":190,"error_subcode":463}}',
        ),
      );

      const error = await adapter
        .sendTextMessage({ phoneNumberId: 'P', to: 'x', body: 'y' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MetaGraphError);
      expect((error as MetaGraphError).isTokenInvalid).toBe(true);
      expect((error as MetaGraphError).status).toBe(401);
      expect((error as MetaGraphError).subcode).toBe(463);
    });

    it('never leaks the access token into the thrown error', async () => {
      fetchMock.mockResolvedValue(errorResponse(500, 'upstream exploded'));

      await expect(
        adapter.sendTextMessage({ phoneNumberId: 'P', to: 'x', body: 'y' }),
      ).rejects.toThrow(
        expect.not.stringContaining('EAAG-access-token') as never,
      );
    });

    it('redacts the access token even if an upstream echoes it back', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(502, 'bad gateway for Bearer EAAG-access-token'),
      );

      const error = await adapter
        .sendTextMessage({ phoneNumberId: 'P', to: 'x', body: 'y' })
        .catch((caught: unknown) => caught as Error);

      expect((error as Error).message).not.toContain('EAAG-access-token');
      expect((error as Error).message).toContain('HTTP 502');
    });

    it('throws when a 200 carries no message id', async () => {
      fetchMock.mockResolvedValue(okResponse({}));

      await expect(
        adapter.sendTextMessage({ phoneNumberId: 'P', to: 'x', body: 'y' }),
      ).rejects.toThrow(/no message id/);
    });
  });

  // Gulf T5 (D5): a send Meta refuses because the token is dead moves the
  // number to reconnect_required, so the console shows a reconnect banner
  // instead of replies silently failing. The original error still reaches
  // the caller (the respond path's retry/escalation is unchanged).
  describe('revoked token on the send path (Gulf T5)', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      transitionByPhoneNumberId.mockClear();
      global.fetch = fetchMock;
    });

    it.each([
      ['a 401', 401, '{"error":{"message":"Invalid OAuth access token"}}'],
      [
        'code 190',
        400,
        '{"error":{"message":"Error validating access token","code":190,"error_subcode":460}}',
      ],
    ])(
      'marks the number reconnect_required on %s and still throws',
      async (_l, status, body) => {
        fetchMock.mockResolvedValue(errorResponse(status, body));

        await expect(
          adapter.sendTextMessage({ phoneNumberId: 'P1', to: 'x', body: 'y' }),
        ).rejects.toBeInstanceOf(MetaGraphError);

        expect(transitionByPhoneNumberId).toHaveBeenCalledWith('P1', {
          kind: 'degrade',
          to: 'reconnect_required',
          reason: CONNECTION_REASONS.tokenRevoked,
        });
      },
    );

    it('does the same for a template send and a media download', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(401, '{"error":{"message":"expired","code":190}}'),
      );
      await expect(
        adapter.sendTemplateMessage({
          phoneNumberId: 'P2',
          to: 'x',
          templateName: 't',
          language: 'en',
          bodyParameters: [],
        }),
      ).rejects.toBeInstanceOf(MetaGraphError);
      await expect(adapter.downloadMedia('P3', 'm')).rejects.toBeInstanceOf(
        MetaGraphError,
      );
      expect(transitionByPhoneNumberId).toHaveBeenNthCalledWith(
        1,
        'P2',
        expect.anything(),
      );
      expect(transitionByPhoneNumberId).toHaveBeenNthCalledWith(
        2,
        'P3',
        expect.anything(),
      );
    });

    it('leaves the state alone for errors a reconnect would not fix', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(
          400,
          '{"error":{"message":"Re-engagement message","code":131047}}',
        ),
      );
      await expect(
        adapter.sendTextMessage({ phoneNumberId: 'P1', to: 'x', body: 'y' }),
      ).rejects.toBeInstanceOf(MetaGraphError);
      expect(transitionByPhoneNumberId).not.toHaveBeenCalled();
    });

    it('surfaces the send error even if recording the state fails', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(401, '{"error":{"message":"expired","code":190}}'),
      );
      transitionByPhoneNumberId.mockRejectedValueOnce(new Error('db down'));
      await expect(
        adapter.sendTextMessage({ phoneNumberId: 'P1', to: 'x', body: 'y' }),
      ).rejects.toBeInstanceOf(MetaGraphError);
    });
  });

  describe('sendTemplateMessage', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      global.fetch = fetchMock;
    });

    it('posts the template payload to the same per-number messages endpoint', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ messages: [{ id: 'wamid.T' }] }),
      );

      const result = await adapter.sendTemplateMessage({
        phoneNumberId: '1195456503655549',
        to: '8801813316904',
        templateName: 'order_shipped',
        language: 'en',
        bodyParameters: ['A-1024'],
      });

      expect(result).toEqual({ bspMessageId: 'wamid.T' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/1195456503655549/messages',
      );
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer EAAG-access-token',
      );
      expect(JSON.parse(init.body as string)).toMatchObject({
        messaging_product: 'whatsapp',
        to: '8801813316904',
        type: 'template',
        template: { name: 'order_shipped' },
      });
    });
  });

  describe('downloadMedia', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      global.fetch = fetchMock;
    });

    it('looks the media up, then fetches the signed url WITH the bearer token', async () => {
      fetchMock
        .mockResolvedValueOnce(
          okResponse({
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=M1',
            mime_type: 'image/jpeg',
          }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        );

      const media = await adapter.downloadMedia('PN', 'MEDIA_1');

      expect(media).toEqual({
        content: Buffer.from([1, 2, 3]),
        mimeType: 'image/jpeg',
      });
      const [lookupUrl, lookupInit] = fetchMock.mock.calls[0];
      expect(lookupUrl).toBe('https://graph.facebook.com/v21.0/MEDIA_1');
      expect((lookupInit.headers as Record<string, string>).Authorization).toBe(
        'Bearer EAAG-access-token',
      );
      const [downloadUrl, downloadInit] = fetchMock.mock.calls[1];
      expect(downloadUrl).toBe(
        'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=M1',
      );
      expect(
        (downloadInit.headers as Record<string, string>).Authorization,
      ).toBe('Bearer EAAG-access-token');
      expect(getCredential).toHaveBeenCalledWith('PN', 'accessToken');
    });

    it('throws a named error when the lookup fails', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(404, '{"error":{"message":"Unsupported get request"}}'),
      );

      await expect(adapter.downloadMedia('PN', 'MEDIA_1')).rejects.toThrow(
        /media lookup failed with HTTP 404.*Unsupported get request/,
      );
    });

    it('throws when the lookup carries no download url', async () => {
      fetchMock.mockResolvedValue(okResponse({ mime_type: 'image/jpeg' }));

      await expect(adapter.downloadMedia('PN', 'MEDIA_1')).rejects.toThrow(
        /no download url/,
      );
    });

    it('throws a named error when the byte download fails', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse({ url: 'https://lookaside/x' }))
        .mockResolvedValueOnce(errorResponse(401, 'unauthorized'));

      await expect(adapter.downloadMedia('PN', 'MEDIA_1')).rejects.toThrow(
        /media download failed with HTTP 401/,
      );
    });
  });

  describe('listTemplates', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      global.fetch = fetchMock;
      getCredential.mockImplementation((_pn: string, key: string) =>
        Promise.resolve(key === 'wabaId' ? 'WABA_123' : 'EAAG-access-token'),
      );
    });

    it('GETs the WABA listing with limit=200 and normalizes rows', async () => {
      fetchMock.mockResolvedValue(
        okResponse({
          data: [
            {
              name: 'order_shipped',
              language: 'en',
              status: 'approved',
              category: 'UTILITY',
            },
            { status: 'APPROVED' },
          ],
        }),
      );

      await expect(adapter.listTemplates('PN')).resolves.toEqual([
        {
          name: 'order_shipped',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
          reason: null,
        },
      ]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/WABA_123/message_templates?limit=200',
      );
      expect(init.method).toBeUndefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer EAAG-access-token',
      );
    });

    it('returns null without calling Meta when no wabaId is stored', async () => {
      getCredential.mockRejectedValue(new Error('missing'));

      await expect(adapter.listTemplates('PN')).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws a named error on a failed listing', async () => {
      fetchMock.mockResolvedValue(errorResponse(500, 'boom'));

      await expect(adapter.listTemplates('PN')).rejects.toThrow(
        /template listing failed with HTTP 500/,
      );
    });
  });

  describe('submitTemplate', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      global.fetch = fetchMock;
      getCredential.mockImplementation((_pn: string, key: string) =>
        Promise.resolve(key === 'wabaId' ? 'WABA_123' : 'EAAG-access-token'),
      );
    });

    // Submission is a WABA-level operation, not a phone-number-level one —
    // unlike a send, where the number is in the path.
    it('posts to the WABA message_templates endpoint, not the number', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ id: '900', status: 'PENDING', category: 'UTILITY' }),
      );

      await adapter.submitTemplate({
        phoneNumberId: '1195456503655549',
        name: 'order_shipped',
        language: 'en',
        category: 'UTILITY',
        body: 'Your order {{1}} ships {{2}}.',
        bodyExamples: ['A-1024', 'Tuesday'],
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/WABA_123/message_templates',
      );
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer EAAG-access-token',
      );
    });

    // body_text is a list of parameter SETS, not a list of parameters. Getting
    // this nesting wrong is the most common way this call 400s, and Meta's
    // error message does not say so.
    it('nests examples as one parameter set inside body_text', async () => {
      fetchMock.mockResolvedValue(okResponse({ id: '900' }));

      await adapter.submitTemplate({
        phoneNumberId: 'P',
        name: 'order_shipped',
        language: 'en',
        category: 'UTILITY',
        body: 'Your order {{1}} ships {{2}}.',
        bodyExamples: ['A-1024', 'Tuesday'],
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({
        name: 'order_shipped',
        language: 'en',
        category: 'UTILITY',
        components: [
          {
            type: 'BODY',
            text: 'Your order {{1}} ships {{2}}.',
            example: { body_text: [['A-1024', 'Tuesday']] },
          },
        ],
      });
    });

    // Meta rejects an empty example object outright, so it must be absent
    // rather than present-and-empty.
    it('omits the example key entirely when there are no placeholders', async () => {
      fetchMock.mockResolvedValue(okResponse({ id: '900' }));

      await adapter.submitTemplate({
        phoneNumberId: 'P',
        name: 'greeting',
        language: 'en',
        category: 'UTILITY',
        body: 'Thanks for getting in touch.',
        bodyExamples: [],
      });

      const [, init] = fetchMock.mock.calls[0];
      const payload = JSON.parse(init.body as string) as {
        components: Record<string, unknown>[];
      };
      expect(payload.components[0]).not.toHaveProperty('example');
    });

    it('reports the id and status Meta returns', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ id: '900', status: 'pending', category: 'UTILITY' }),
      );

      await expect(
        adapter.submitTemplate({
          phoneNumberId: 'P',
          name: 'n',
          language: 'en',
          category: 'UTILITY',
          body: 'b',
          bodyExamples: [],
        }),
      ).resolves.toEqual({
        providerTemplateId: '900',
        status: 'PENDING',
        category: 'UTILITY',
      });
    });

    // An unconfigured number must not look like a rejected template.
    it('returns null when the number has no wabaId stored', async () => {
      getCredential.mockImplementation((_pn: string, key: string) =>
        key === 'wabaId'
          ? Promise.reject(new Error('missing'))
          : Promise.resolve('token'),
      );

      await expect(
        adapter.submitTemplate({
          phoneNumberId: 'P',
          name: 'n',
          language: 'en',
          category: 'UTILITY',
          body: 'b',
          bodyExamples: [],
        }),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // Meta's message names the exact policy rule broken — it is the only clue
    // the tenant has for fixing the template, so it must not be paraphrased.
    it("surfaces Meta's rejection detail verbatim", async () => {
      fetchMock.mockResolvedValue(
        errorResponse(400, '{"error":{"message":"template name exists"}}'),
      );

      await expect(
        adapter.submitTemplate({
          phoneNumberId: 'P',
          name: 'n',
          language: 'en',
          category: 'UTILITY',
          body: 'b',
          bodyExamples: [],
        }),
      ).rejects.toThrow(/template name exists/);
    });
  });
});
