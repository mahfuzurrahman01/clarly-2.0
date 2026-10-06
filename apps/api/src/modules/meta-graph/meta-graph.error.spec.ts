// Gulf T5 (D5): which Graph failures mean "this WhatsApp number's token is
// dead" (degrade to reconnect_required) versus anything a retry or Meta-side
// fix can clear.
import { MetaGraphError } from './meta-graph.error';

describe('MetaGraphError.isAccessTokenRevoked', () => {
  it.each([
    ['HTTP 401 with no Meta code', 401, null],
    ['code 190 (OAuthException: token expired or revoked)', 400, 190],
    ['code 190 on a 401', 401, 190],
    ['code 102 (session expired)', 400, 102],
  ])('is true for %s', (_label, status, code) => {
    expect(
      new MetaGraphError(status, code, null, 'x').isAccessTokenRevoked,
    ).toBe(true);
  });

  it.each([
    [
      'a permission error (code 10): a grant problem, not a dead token',
      403,
      10,
    ],
    ['a rate limit (code 4)', 400, 4],
    ['a policy restriction (131031)', 400, 131031],
    ['a payment problem (131042)', 400, 131042],
    ['a Meta outage', 500, null],
    ['a 2xx body with no message id', 200, null],
  ])('is false for %s', (_label, status, code) => {
    expect(
      new MetaGraphError(status, code, null, 'x').isAccessTokenRevoked,
    ).toBe(false);
  });

  it('survives withOperation()', () => {
    const wrapped = new MetaGraphError(400, 190, 463, 'expired').withOperation(
      'send',
    );
    expect(wrapped.isAccessTokenRevoked).toBe(true);
  });
});
