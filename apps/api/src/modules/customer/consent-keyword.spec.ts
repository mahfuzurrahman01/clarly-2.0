import { parseConsentKeyword } from './consent-keyword';

describe('parseConsentKeyword()', () => {
  it.each([
    'stop',
    'STOP',
    'Stop',
    'unsubscribe',
    'cancel',
    'end',
    'quit',
    'optout',
    'opt out',
  ])('reads %j as an opt-out', (text) => {
    expect(parseConsentKeyword(text)).toBe('opt_out');
  });

  it.each(['start', 'START', 'unstop', 'subscribe', 'optin', 'opt in'])(
    'reads %j as an opt-in',
    (text) => {
      expect(parseConsentKeyword(text)).toBe('opt_in');
    },
  );

  it('tolerates surrounding whitespace and punctuation', () => {
    expect(parseConsentKeyword('  STOP.  ')).toBe('opt_out');
    expect(parseConsentKeyword('"stop"')).toBe('opt_out');
    expect(parseConsentKeyword('start!')).toBe('opt_in');
  });

  it('collapses inner whitespace so "opt   out" still counts', () => {
    expect(parseConsentKeyword('opt   out')).toBe('opt_out');
  });

  // The important half. Substring matching is the obvious instinct and it is
  // wrong: silently unsubscribing someone who asked for the opposite is a far
  // worse failure than missing an unusual phrasing.
  it.each([
    "please don't stop sending me updates",
    'I stopped receiving these',
    'can you cancel my order',
    'when does the subscription end',
    'my flight was cancelled',
    'where do I start',
    'stop by the shop tomorrow',
  ])('does not treat %j as a consent keyword', (text) => {
    expect(parseConsentKeyword(text)).toBeNull();
  });

  it.each([null, undefined, '', '   ', '...'])(
    'returns null for %j',
    (text) => {
      expect(parseConsentKeyword(text)).toBeNull();
    },
  );
});
