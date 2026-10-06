// Gulf T7 (D7): the signed_request Meta POSTs to the data-deletion and
// deauthorize callbacks. Every assertion here is a way a forged or damaged
// request must be refused BEFORE any data is touched.
import { createHmac } from 'node:crypto';
import {
  InvalidSignedRequestError,
  parseMetaSignedRequest,
} from './meta-signed-request';

const SECRET = 'test-app-secret';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Builds a signed_request exactly the way Meta documents it: base64url(HMAC-SHA256(secret, encodedPayload)) + '.' + encodedPayload. */
function sign(payload: unknown, secret = SECRET): string {
  const encodedPayload = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(encodedPayload).digest();
  return `${base64url(sig)}.${encodedPayload}`;
}

const VALID_PAYLOAD = {
  algorithm: 'HMAC-SHA256',
  expires: 1291840400,
  issued_at: 1291836800,
  user_id: '218471',
};

function without(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => k !== key));
}

function expectRejected(
  signedRequest: string,
  kind: InvalidSignedRequestError['kind'],
  secret = SECRET,
): void {
  let caught: unknown;
  try {
    parseMetaSignedRequest(signedRequest, secret);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidSignedRequestError);
  expect((caught as InvalidSignedRequestError).kind).toBe(kind);
}

describe('parseMetaSignedRequest', () => {
  it("accepts Meta's documented example payload and returns the app-scoped user id", () => {
    const parsed = parseMetaSignedRequest(sign(VALID_PAYLOAD), SECRET);

    expect(parsed).toEqual({
      userId: '218471',
      issuedAt: new Date(1291836800 * 1000),
    });
  });

  it('accepts a numeric user_id (JSON number) as the same id string', () => {
    const parsed = parseMetaSignedRequest(
      sign({ ...VALID_PAYLOAD, user_id: 218471 }),
      SECRET,
    );
    expect(parsed.userId).toBe('218471');
  });

  it('accepts the algorithm name case-insensitively, as the Facebook SDKs do', () => {
    const parsed = parseMetaSignedRequest(
      sign({ ...VALID_PAYLOAD, algorithm: 'hmac-sha256' }),
      SECRET,
    );
    expect(parsed.userId).toBe('218471');
  });

  it('rejects a request signed with a different secret', () => {
    expectRejected(sign(VALID_PAYLOAD, 'someone-elses-secret'), 'signature');
  });

  it('rejects a tampered payload (user_id swapped after signing)', () => {
    const [sig] = sign(VALID_PAYLOAD).split('.');
    const forgedPayload = base64url(
      JSON.stringify({ ...VALID_PAYLOAD, user_id: '999999' }),
    );
    expectRejected(`${sig}.${forgedPayload}`, 'signature');
  });

  it('rejects a truncated signature', () => {
    const [sig, payload] = sign(VALID_PAYLOAD).split('.');
    expectRejected(`${sig.slice(0, 20)}.${payload}`, 'signature');
  });

  it('rejects a correctly signed payload whose algorithm is not HMAC-SHA256', () => {
    expectRejected(sign({ ...VALID_PAYLOAD, algorithm: 'none' }), 'algorithm');
    expectRejected(
      sign({ ...VALID_PAYLOAD, algorithm: 'HMAC-SHA1' }),
      'algorithm',
    );
  });

  it('rejects a correctly signed payload with no algorithm at all', () => {
    expectRejected(sign(without(VALID_PAYLOAD, 'algorithm')), 'algorithm');
  });

  it.each([
    ['empty string', ''],
    ['no separator', 'abcdef'],
    ['empty signature', '.eyJhIjoxfQ'],
    ['empty payload', 'abc.'],
    ['non-base64url characters', 'ab$c.ey+J/hIjoxfQ'],
  ])('rejects a malformed request (%s)', (_label, value) => {
    expectRejected(value, 'malformed');
  });

  it('rejects an oversized request without hashing it', () => {
    expectRejected(`${'a'.repeat(9000)}.${'b'.repeat(9000)}`, 'malformed');
  });

  it('rejects a correctly signed payload that is not JSON', () => {
    const encodedPayload = base64url('not json');
    const sig = createHmac('sha256', SECRET).update(encodedPayload).digest();
    expectRejected(`${base64url(sig)}.${encodedPayload}`, 'malformed');
  });

  it('rejects a correctly signed payload with a missing or non-numeric user_id', () => {
    expectRejected(sign(without(VALID_PAYLOAD, 'user_id')), 'malformed');
    expectRejected(
      sign({ ...VALID_PAYLOAD, user_id: '../../etc' }),
      'malformed',
    );
  });

  it('fails closed when no app secret is configured', () => {
    expectRejected(sign(VALID_PAYLOAD, ''), 'not_configured', '');
  });
});
