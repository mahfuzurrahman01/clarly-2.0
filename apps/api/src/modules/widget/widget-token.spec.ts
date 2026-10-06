import {
  deriveWidgetTokenKey,
  isVisitorId,
  newVisitorId,
  signVisitor,
  verifyVisitor,
} from './widget-token';

const KEY = deriveWidgetTokenKey(Buffer.alloc(32, 7).toString('base64'));
const WIDGET = '11111111-1111-4111-8111-111111111111';

describe('widget visitor token', () => {
  it('derives a key distinct from the encryption key', () => {
    expect(KEY.equals(Buffer.alloc(32, 7))).toBe(false);
    expect(KEY).toHaveLength(32);
  });

  it('verifies a token it signed', () => {
    const visitor = newVisitorId();
    expect(isVisitorId(visitor)).toBe(true);
    expect(
      verifyVisitor(KEY, WIDGET, visitor, signVisitor(KEY, WIDGET, visitor)),
    ).toBe(true);
  });

  it('refuses another visitor’s token, another widget’s, a malformed id or a tampered token', () => {
    const a = newVisitorId();
    const b = newVisitorId();
    const tokenA = signVisitor(KEY, WIDGET, a);
    expect(verifyVisitor(KEY, WIDGET, b, tokenA)).toBe(false);
    expect(
      verifyVisitor(KEY, '22222222-2222-4222-8222-222222222222', a, tokenA),
    ).toBe(false);
    expect(verifyVisitor(KEY, WIDGET, 'web_not-a-uuid', tokenA)).toBe(false);
    expect(
      verifyVisitor(
        KEY,
        WIDGET,
        a,
        tokenA.slice(0, -1) + (tokenA.endsWith('A') ? 'B' : 'A'),
      ),
    ).toBe(false);
    expect(verifyVisitor(KEY, WIDGET, a, '')).toBe(false);
  });
});
