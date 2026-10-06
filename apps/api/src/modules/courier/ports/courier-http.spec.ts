// F26 (D2/D10): the shared courier HTTP helpers.
//
// `parseCourierDate` gets its own attention because `occurred_at` is part of
// the status-history dedup key — a date that drifts by the server's timezone
// offset would make every re-poll insert a "new" event.
import {
  asArray,
  asRecord,
  courierFetchJson,
  parseCourierDate,
  pickString,
  requireCredential,
} from './courier-http';
import {
  CourierAuthenticationError,
  CourierTransportError,
} from './courier-connector.port';
import { statusFromKeywords } from './status-keywords';

function mockFetch(impl: unknown): void {
  global.fetch = impl as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('courierFetchJson', () => {
  it('turns 401/403 into an authentication error', async () => {
    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 403 }));

    await expect(
      courierFetchJson('smsa', { url: 'https://example.test' }),
    ).rejects.toBeInstanceOf(CourierAuthenticationError);
  });

  it('turns any other non-2xx into a retryable transport error', async () => {
    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(
      courierFetchJson('smsa', { url: 'https://example.test' }),
    ).rejects.toBeInstanceOf(CourierTransportError);
  });

  it('turns a non-JSON body into a transport error rather than a crash', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('Unexpected token <')),
      }),
    );

    await expect(
      courierFetchJson('smsa', { url: 'https://example.test' }),
    ).rejects.toBeInstanceOf(CourierTransportError);
  });

  it('turns a network failure into a transport error', async () => {
    mockFetch(jest.fn().mockRejectedValue(new Error('ECONNRESET')));

    await expect(
      courierFetchJson('naqel', { url: 'https://example.test' }),
    ).rejects.toBeInstanceOf(CourierTransportError);
  });
});

describe('parseCourierDate', () => {
  const fallback = new Date('2020-01-01T00:00:00Z');

  it('reads a zoneless "YYYY-MM-DD HH:mm:ss" as UTC, not as server-local time', () => {
    // Several Gulf courier APIs emit exactly this. `new Date()` would read it
    // as LOCAL, shifting stored history by the deployment's offset.
    expect(parseCourierDate('2026-09-21 14:03:00').toISOString()).toBe(
      '2026-09-21T14:03:00.000Z',
    );
  });

  it('keeps an explicit offset intact', () => {
    expect(parseCourierDate('2026-09-21T14:03:00Z').toISOString()).toBe(
      '2026-09-21T14:03:00.000Z',
    );
  });

  it('reads a seconds epoch as seconds and a millis epoch as millis', () => {
    expect(parseCourierDate(1_600_000_000).toISOString()).toBe(
      new Date(1_600_000_000_000).toISOString(),
    );
    expect(parseCourierDate(1_600_000_000_000).toISOString()).toBe(
      new Date(1_600_000_000_000).toISOString(),
    );
  });

  // An unreadable date is NOT an error: the event still happened, we just do
  // not know when. A NaN date would poison the dedup key instead.
  it('falls back rather than producing an invalid date', () => {
    expect(parseCourierDate(undefined, fallback)).toBe(fallback);
    expect(parseCourierDate('', fallback)).toBe(fallback);
    expect(parseCourierDate('not a date', fallback)).toBe(fallback);
  });
});

describe('field helpers', () => {
  it('picks the first non-empty string among renamed fields', () => {
    expect(pickString({ a: '', b: '  ', c: ' Riyadh ' }, 'a', 'b', 'c')).toBe(
      'Riyadh',
    );
    expect(pickString({ n: 7 }, 'n')).toBe('7');
    expect(pickString({}, 'missing')).toBeUndefined();
  });

  it('narrows unknown JSON without reaching for any', () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asArray('nope')).toEqual([]);
    expect(asArray([1])).toEqual([1]);
  });

  it('names the missing credential rather than sending an empty string', () => {
    expect(() =>
      requireCredential('jt', { apiAccount: ' ' }, 'apiAccount'),
    ).toThrow(/apiAccount/);
    expect(requireCredential('jt', { apiAccount: ' a ' }, 'apiAccount')).toBe(
      'a',
    );
  });
});

describe('statusFromKeywords', () => {
  // Order matters: the more specific phrases have to win, or "delivery
  // attempt" resolves to "delivered" and a customer is told their parcel
  // arrived when it did not.
  it('prefers the specific phrase over the general one', () => {
    expect(statusFromKeywords('Delivery attempt failed')).toBe(
      'failed_attempt',
    );
    expect(statusFromKeywords('Out for delivery')).toBe('out_for_delivery');
    expect(statusFromKeywords('Delivered to consignee')).toBe('delivered');
  });

  it('returns null — not "unknown" — when no rule applies', () => {
    expect(statusFromKeywords('Parcel weighed')).toBeNull();
    expect(statusFromKeywords(undefined)).toBeNull();
  });
});
