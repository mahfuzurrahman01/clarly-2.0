// Wire-level spec: the REAL MetaGraphClient over a stubbed fetch, so the
// requests asserted here are the ones that hit graph.facebook.com. Response
// bodies are recorded shapes from Meta's docs ("Onboarding business
// customers as a Tech Provider", "Manage accounts" debug_token sample,
// "Manage phone numbers", Cloud API error codes).
import type { AppConfigService } from '../../core';
import { MetaGraphClient } from '../../meta-graph/meta-graph.client';
import { MetaEmbeddedSignupAdapter } from './meta-embedded-signup.adapter';
import { EmbeddedSignupError } from './ports/embedded-signup.port';

const TOKEN = 'BUSINESS-TOKEN';
const WABA = '102289599326934';
const PHONE = '106540352242922';

const config = {
  metaGraphBaseUrl: 'https://graph.facebook.com',
  metaGraphVersion: 'v21.0',
  bspRequestTimeoutMs: 5000,
  metaAppId: 'OUR_APP',
  metaAppSecret: 'our-app-secret',
} as AppConfigService;

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function graphError(status: number, code: number, message: string): Response {
  return json(status, {
    error: { message, type: 'OAuthException', code, fbtrace_id: 'A1' },
  });
}

async function caught(promise: Promise<unknown>): Promise<EmbeddedSignupError> {
  try {
    await promise;
  } catch (error) {
    return error as EmbeddedSignupError;
  }
  throw new Error('expected rejection');
}

describe('MetaEmbeddedSignupAdapter', () => {
  const originalFetch = global.fetch;
  let adapter: MetaEmbeddedSignupAdapter;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    adapter = new MetaEmbeddedSignupAdapter(
      new MetaGraphClient(config),
      config,
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('exchangeCode', () => {
    it('returns the business token', async () => {
      fetchMock.mockResolvedValue(
        json(200, { access_token: TOKEN, token_type: 'bearer' }),
      );
      await expect(adapter.exchangeCode('CODE')).resolves.toBe(TOKEN);
      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(url.pathname).toBe('/v21.0/oauth/access_token');
      expect(url.searchParams.get('client_id')).toBe('OUR_APP');
      expect(url.searchParams.get('code')).toBe('CODE');
    });

    it('maps a 4xx (code reused / expired) to invalid_code', async () => {
      fetchMock.mockResolvedValue(
        graphError(400, 100, 'This authorization code has been used.'),
      );
      const error = await caught(adapter.exchangeCode('CODE'));
      expect(error).toBeInstanceOf(EmbeddedSignupError);
      expect(error.failure).toBe('invalid_code');
      expect(error.message).not.toContain('our-app-secret');
    });

    it('maps a 5xx to upstream', async () => {
      fetchMock.mockResolvedValue(graphError(500, 1, 'An unknown error'));
      expect((await caught(adapter.exchangeCode('CODE'))).failure).toBe(
        'upstream',
      );
    });
  });

  describe('inspectGrant', () => {
    const debugToken = (appId: string, isValid = true) =>
      json(200, {
        data: {
          app_id: appId,
          type: 'SYSTEM_USER',
          user_id: '122100000000000001',
          is_valid: isValid,
          granular_scopes: [
            {
              scope: 'whatsapp_business_management',
              target_ids: [WABA, '101569239400667'],
            },
            { scope: 'whatsapp_business_messaging', target_ids: [WABA] },
          ],
        },
      });

    it('splits target ids by WhatsApp scope', async () => {
      fetchMock.mockResolvedValue(debugToken('OUR_APP'));
      await expect(adapter.inspectGrant(TOKEN)).resolves.toEqual({
        valid: true,
        managementWabaIds: [WABA, '101569239400667'],
        messagingWabaIds: [WABA],
        metaUserId: '122100000000000001',
      });
    });

    it('is invalid when the token was issued to a different app', async () => {
      fetchMock.mockResolvedValue(debugToken('SOMEONE_ELSES_APP'));
      expect((await adapter.inspectGrant(TOKEN)).valid).toBe(false);
    });

    it('is invalid when Meta says so', async () => {
      fetchMock.mockResolvedValue(debugToken('OUR_APP', false));
      expect((await adapter.inspectGrant(TOKEN)).valid).toBe(false);
    });
  });

  describe('listPhoneNumbers', () => {
    it('GETs /{waba}/phone_numbers with the coexistence field and bearer auth', async () => {
      fetchMock.mockResolvedValue(
        json(200, {
          data: [
            {
              verified_name: 'Jasper Market',
              display_phone_number: '+1 631-555-5555',
              id: PHONE,
              quality_rating: 'GREEN',
              is_on_biz_app: false,
            },
            {
              verified_name: 'Jasper Market',
              display_phone_number: '+1 631-555-5556',
              id: '106540352242923',
              quality_rating: 'GREEN',
              is_on_biz_app: true,
            },
            { verified_name: 'no id' },
          ],
          paging: { cursors: { before: 'a', after: 'b' } },
        }),
      );

      await expect(adapter.listPhoneNumbers(WABA, TOKEN)).resolves.toEqual([
        {
          id: PHONE,
          displayPhoneNumber: '+1 631-555-5555',
          isOnBizApp: false,
        },
        {
          id: '106540352242923',
          displayPhoneNumber: '+1 631-555-5556',
          isOnBizApp: true,
        },
      ]);
      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(`/v21.0/${WABA}/phone_numbers`);
      expect(parsed.searchParams.get('fields')).toContain('is_on_biz_app');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it('returns an empty list for a body with no data array', async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      await expect(adapter.listPhoneNumbers(WABA, TOKEN)).resolves.toEqual([]);
    });
  });

  describe('subscribeApp', () => {
    it('POSTs /{waba}/subscribed_apps', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true }));
      await adapter.subscribeApp(WABA, TOKEN);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        `https://graph.facebook.com/v21.0/${WABA}/subscribed_apps`,
      );
      expect(init.method).toBe('POST');
    });

    it('maps failure to upstream', async () => {
      fetchMock.mockResolvedValue(graphError(403, 200, 'Permissions error'));
      expect((await caught(adapter.subscribeApp(WABA, TOKEN))).failure).toBe(
        'upstream',
      );
    });
  });

  describe('registerPhoneNumber', () => {
    it('POSTs messaging_product + pin to /{phone}/register', async () => {
      fetchMock.mockResolvedValue(json(200, { success: true }));
      await adapter.registerPhoneNumber(PHONE, '123456', TOKEN);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://graph.facebook.com/v21.0/${PHONE}/register`);
      expect(JSON.parse(init.body as string)).toEqual({
        messaging_product: 'whatsapp',
        pin: '123456',
      });
    });

    it.each([
      [133005, 'pin_mismatch'],
      [133008, 'pin_locked'],
      [133009, 'pin_locked'],
      [133016, 'pin_locked'],
      [133004, 'upstream'],
      [133015, 'upstream'],
    ])('maps Meta error %i to %s', async (code, failure) => {
      fetchMock.mockResolvedValue(graphError(400, code, 'registration failed'));
      const error = await caught(
        adapter.registerPhoneNumber(PHONE, '123456', TOKEN),
      );
      expect(error.failure).toBe(failure);
      expect(error.message).not.toContain(TOKEN);
    });
  });
});
