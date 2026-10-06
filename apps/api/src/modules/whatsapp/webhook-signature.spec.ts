import { createHmac } from 'node:crypto';
import { findSignatureHeader, verifyHmacSha256 } from './webhook-signature';

const SECRET = 'shared-secret';
const BODY = '{"entry":[{"changes":[]}]}';

const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
const base64 = createHmac('sha256', SECRET).update(BODY).digest('base64');

describe('findSignatureHeader', () => {
  it('finds the header regardless of case', () => {
    expect(
      findSignatureHeader(
        { 'X-Hub-Signature-256': 'abc' },
        'x-hub-signature-256',
      ),
    ).toBe('abc');
  });

  it('strips a sha256= prefix (Meta sends one; tolerate its absence)', () => {
    expect(findSignatureHeader({ h: 'sha256=abc' }, 'h')).toBe('abc');
    expect(findSignatureHeader({ h: 'SHA256=abc' }, 'h')).toBe('abc');
  });

  it('trims surrounding whitespace', () => {
    expect(findSignatureHeader({ h: '  abc  ' }, 'h')).toBe('abc');
  });

  it('returns undefined when absent, without throwing', () => {
    expect(findSignatureHeader({}, 'h')).toBeUndefined();
    expect(findSignatureHeader({ other: 'x' }, 'h')).toBeUndefined();
  });
});

describe('verifyHmacSha256', () => {
  it('accepts the hex encoding of the digest', () => {
    expect(verifyHmacSha256(BODY, hex, SECRET)).toBe(true);
  });

  it('accepts the base64 encoding of the same digest', () => {
    // Both are the same MAC under the same secret, so accepting either
    // concedes nothing (see verifyHmacSha256's comment).
    expect(verifyHmacSha256(BODY, base64, SECRET)).toBe(true);
  });

  it('accepts a Buffer body identically to a string body', () => {
    expect(verifyHmacSha256(Buffer.from(BODY), hex, SECRET)).toBe(true);
  });

  it('rejects a digest computed over different bytes', () => {
    expect(verifyHmacSha256(`${BODY} `, hex, SECRET)).toBe(false);
  });

  it('rejects a digest computed under a different secret', () => {
    const forged = createHmac('sha256', 'other').update(BODY).digest('hex');
    expect(verifyHmacSha256(BODY, forged, SECRET)).toBe(false);
  });

  it('fails closed on an empty secret', () => {
    expect(verifyHmacSha256(BODY, hex, '')).toBe(false);
  });

  it('fails closed on an absent signature', () => {
    expect(verifyHmacSha256(BODY, undefined, SECRET)).toBe(false);
    expect(verifyHmacSha256(BODY, '', SECRET)).toBe(false);
  });

  it('fails closed on a garbage signature rather than throwing', () => {
    expect(verifyHmacSha256(BODY, 'not-a-signature', SECRET)).toBe(false);
  });

  it('rejects a truncated but otherwise correct prefix (length mismatch)', () => {
    expect(verifyHmacSha256(BODY, hex.slice(0, 32), SECRET)).toBe(false);
  });
});
