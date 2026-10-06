// F26 (Delivery Tracking), D10 Unit: each of the four adapters, driven by the
// recorded fixtures in `__fixtures__/courier-responses.ts`.
//
// Every adapter is asserted on the same three things:
//   - its own status codes map into the platform vocabulary,
//   - an UNMAPPED code degrades through the shared keyword pass and then to
//     `unknown` — never to a plausible-looking wrong status,
//   - courier free prose (`Comments`, problem descriptions) never leaves the
//     adapter in any field a caller could forward to the model.
import { AramexConnector, isAramexAuthFailure } from './aramex.connector';
import { JtConnector, JT_DIGEST_HEADER } from './jt.connector';
import { NaqelConnector } from './naqel.connector';
import { NoopCourierConnector } from './noop-courier.connector';
import { SmsaConnector } from './smsa.connector';
import {
  CourierAuthenticationError,
  CourierTransportError,
} from './courier-connector.port';
import {
  ARAMEX_AUTH_FAILURE_RESPONSE,
  ARAMEX_TRACK_RESPONSE,
  ARAMEX_UNKNOWN_WAYBILL_RESPONSE,
  JT_TRACE_RESPONSE,
  JT_WEBHOOK_BODY,
  JT_WEBHOOK_BODY_WITH_TENANT_CLAIM,
  NAQEL_AUTH_FAILURE_RESPONSE,
  NAQEL_TRACK_RESPONSE,
  SMSA_TRACK_RESPONSE,
} from './__fixtures__/courier-responses';

const logger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function mockFetchOnce(body: unknown, status = 200): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fetchMock;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AramexConnector', () => {
  const credentials = {
    username: 'u',
    password: 'p',
    accountNumber: '1',
    accountPin: '2',
    accountEntity: 'RUH',
    accountCountryCode: 'SA',
  };

  it('maps Aramex update codes into the platform status vocabulary', async () => {
    mockFetchOnce(ARAMEX_TRACK_RESPONSE);

    const [result] = await new AramexConnector().track(credentials, [
      '47384974350',
    ]);

    expect(result.trackingNumber).toBe('47384974350');
    expect(result.events.map((e) => e.status)).toEqual([
      'label_created',
      'out_for_delivery',
      // SH099 is not in the code table; the description carries it.
      'delivered',
    ]);
    expect(result.currentStatus).toBe('delivered');
    expect(result.estimatedDeliveryAt).toEqual(
      new Date('2026-09-21T15:00:00Z'),
    );
  });

  // D10 adversarial: F26's entire input surface is third-party strings.
  it('never carries a courier Comments field out of the adapter', async () => {
    mockFetchOnce(ARAMEX_TRACK_RESPONSE);

    const [result] = await new AramexConnector().track(credentials, [
      '47384974350',
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('IGNORE PREVIOUS INSTRUCTIONS');
    expect(serialized).not.toContain('refund is approved');
  });

  it('treats a credential rejection inside a 200 as an authentication error', async () => {
    mockFetchOnce(ARAMEX_AUTH_FAILURE_RESPONSE);

    await expect(
      new AramexConnector().track(credentials, ['1']),
    ).rejects.toBeInstanceOf(CourierAuthenticationError);
  });

  // The distinction that decides whether a merchant's connection is
  // deactivated: "your password is wrong" versus "that waybill does not
  // exist", both of which arrive as HasErrors inside a 200.
  it('does not mistake an unknown waybill for a credential rejection', async () => {
    mockFetchOnce(ARAMEX_UNKNOWN_WAYBILL_RESPONSE);

    await expect(
      new AramexConnector().track(credentials, ['1']),
    ).rejects.toBeInstanceOf(CourierTransportError);
  });

  it('accepts credentials when the probe waybill simply does not exist', async () => {
    mockFetchOnce(ARAMEX_UNKNOWN_WAYBILL_RESPONSE);

    await expect(
      new AramexConnector().verifyCredentials(credentials),
    ).resolves.toBeUndefined();
  });

  it('refuses credentials the courier rejected', async () => {
    mockFetchOnce(ARAMEX_AUTH_FAILURE_RESPONSE);

    await expect(
      new AramexConnector().verifyCredentials(credentials),
    ).rejects.toBeInstanceOf(CourierAuthenticationError);
  });

  it('names the missing credential rather than sending an empty string', async () => {
    await expect(
      new AramexConnector().verifyCredentials({ username: 'u' }),
    ).rejects.toThrow(/password/);
  });

  it('accepts no push callbacks at all', () => {
    const connector = new AramexConnector();
    expect(connector.webhookSignatureHeader).toBeNull();
    expect(connector.verifyWebhookSignature()).toBe(false);
    expect(connector.normalizeWebhookEvent()).toBeNull();
  });

  it('classifies notification text', () => {
    expect(isAramexAuthFailure('Invalid username or password')).toBe(true);
    expect(isAramexAuthFailure('Waybill number does not exist')).toBe(false);
  });
});

describe('SmsaConnector', () => {
  const credentials = { apiKey: 'k' };

  it('maps SMSA activity codes and degrades an unmapped one by keyword', async () => {
    mockFetchOnce(SMSA_TRACK_RESPONSE);

    const [result] = await new SmsaConnector().track(credentials, [
      '287654321098',
    ]);

    expect(result.events.map((e) => e.status)).toEqual([
      'picked_up',
      'in_transit',
      // 'ZZZ' is unmapped; "held at customs" is an exception, not a guess.
      'exception',
    ]);
    expect(result.estimatedDeliveryAt).toEqual(
      new Date('2026-09-21T12:00:00Z'),
    );
  });

  it('sends the API key in SMSA’s own `apikey` header', async () => {
    const fetchMock = mockFetchOnce(SMSA_TRACK_RESPONSE);

    await new SmsaConnector().track(credentials, ['287654321098']);

    const init = fetchMock.mock.calls[0][1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.apikey).toBe('k');
  });

  it('turns a 401 into an authentication error, not a retryable one', async () => {
    mockFetchOnce({}, 401);

    await expect(
      new SmsaConnector().verifyCredentials(credentials),
    ).rejects.toBeInstanceOf(CourierAuthenticationError);
  });
});

describe('NaqelConnector', () => {
  const credentials = { clientId: 'c', password: 'p' };

  it('maps Naqel activity codes and lands an unrecognizable one on unknown', async () => {
    mockFetchOnce(NAQEL_TRACK_RESPONSE);

    const [result] = await new NaqelConnector().track(credentials, [
      '9900112233',
    ]);

    expect(result.events.map((e) => e.status)).toEqual([
      'picked_up',
      'out_for_delivery',
      // Neither the code table nor any keyword rule matches "Data captured".
      // `unknown` is the honest answer; a plausible guess would not be.
      'unknown',
    ]);
    expect(result.currentStatus).toBe('unknown');
    expect(result.estimatedDeliveryAt).toEqual(
      new Date('2026-09-21T18:00:00Z'),
    );
  });

  it('treats a credential rejection inside a 200 as an authentication error', async () => {
    mockFetchOnce(NAQEL_AUTH_FAILURE_RESPONSE);

    await expect(
      new NaqelConnector().track(credentials, ['1']),
    ).rejects.toBeInstanceOf(CourierAuthenticationError);
  });
});

describe('JtConnector', () => {
  const credentials = { apiAccount: 'a', privateKey: 'secret' };

  it('maps J&T scan types and degrades an unmapped one by keyword', async () => {
    mockFetchOnce(JT_TRACE_RESPONSE);

    const [result] = await new JtConnector().track(credentials, [
      'JT0000123456',
    ]);

    expect(result.events.map((e) => e.status)).toEqual([
      'picked_up',
      'out_for_delivery',
      // "Weighing Scan" / "Parcel weighed" matches nothing.
      'unknown',
    ]);
    expect(result.estimatedDeliveryAt).toEqual(
      new Date('2026-09-21T20:00:00Z'),
    );
  });

  it('leaves estimatedDeliveryAt undefined rather than defaulting to "now" when the courier gives no ETA', async () => {
    mockFetchOnce({
      code: '1',
      msg: 'success',
      data: [{ billCode: 'JT0000123456', details: [] }],
    });

    const [result] = await new JtConnector().track(credentials, [
      'JT0000123456',
    ]);

    expect(result.estimatedDeliveryAt).toBeUndefined();
  });

  it('signs outbound requests with base64(MD5(body + privateKey))', async () => {
    const fetchMock = mockFetchOnce(JT_TRACE_RESPONSE);

    await new JtConnector().track(credentials, ['JT0000123456']);

    const init = fetchMock.mock.calls[0][1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(init.headers.digest).toBe(JtConnector.digest(init.body, 'secret'));
  });

  it('accepts a correctly signed callback and refuses a forged one', () => {
    const connector = new JtConnector();
    const body = Buffer.from(JSON.stringify(JT_WEBHOOK_BODY), 'utf8');
    const good = JtConnector.digest(body.toString('utf8'), 'secret');

    expect(connector.webhookSignatureHeader).toBe(JT_DIGEST_HEADER);
    expect(connector.verifyWebhookSignature(body, good, 'secret')).toBe(true);
    expect(connector.verifyWebhookSignature(body, good, 'other')).toBe(false);
    // A short forged signature must be a clean `false`, not a thrown
    // length-mismatch from timingSafeEqual (F24's first cut 500'd here).
    expect(connector.verifyWebhookSignature(body, 'x', 'secret')).toBe(false);
    expect(connector.verifyWebhookSignature(body, '', 'secret')).toBe(false);
  });

  it('normalizes a callback into platform status events', () => {
    const normalized = new JtConnector().normalizeWebhookEvent(
      JT_WEBHOOK_BODY,
      {},
    );

    expect(normalized?.trackingNumber).toBe('JT0000123456');
    expect(normalized?.events.map((e) => e.status)).toEqual(['delivered']);
  });

  // D10 adversarial: a body claiming a tenant.
  it('reads nothing tenant-shaped out of a callback body', () => {
    const normalized = new JtConnector().normalizeWebhookEvent(
      JT_WEBHOOK_BODY_WITH_TENANT_CLAIM,
      {},
    );

    expect(normalized?.trackingNumber).toBe('JT0000123456');
    expect(JSON.stringify(normalized)).not.toContain('000000000bad');
  });

  it('derives a stable event id from the body when J&T supplies none', () => {
    const connector = new JtConnector();

    const first = connector.extractEventId(JT_WEBHOOK_BODY);
    const replay = connector.extractEventId(JT_WEBHOOK_BODY);
    const different = connector.extractEventId({
      ...JT_WEBHOOK_BODY,
      data: [],
    });

    // A replayed body claims the same id and therefore loses the claim.
    expect(first).toBe(replay);
    expect(first).not.toBe(different);
  });
});

describe('NoopCourierConnector', () => {
  // An unknown courier must never resolve to something that pretends a call
  // worked — that is how a shipment sits at `label_created` forever while the
  // console shows a healthy connection.
  it('fails closed on credentials and on signatures', async () => {
    const connector = new NoopCourierConnector(
      logger as unknown as ConstructorParameters<
        typeof NoopCourierConnector
      >[0],
    );

    await expect(connector.verifyCredentials()).rejects.toBeInstanceOf(
      CourierAuthenticationError,
    );
    expect(connector.webhookSignatureHeader).toBeNull();
    expect(connector.verifyWebhookSignature()).toBe(false);
    expect(connector.extractEventId()).toBeNull();
    expect(connector.normalizeWebhookEvent()).toBeNull();
    // A read-shaped refusal, not a throw: a sweep that threw here would mark
    // the whole batch failed, when in truth we simply learned nothing.
    await expect(connector.track()).resolves.toEqual([]);
  });
});
