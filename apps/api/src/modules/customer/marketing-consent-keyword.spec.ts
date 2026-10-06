import { isMarketingOptOutKeyword } from './marketing-consent-keyword';

describe('isMarketingOptOutKeyword()', () => {
  it.each(['stop marketing', 'STOP MARKETING', 'unsubscribe', 'UNSUBSCRIBE'])(
    'reads %j as a marketing opt-out',
    (text) => {
      expect(isMarketingOptOutKeyword(text)).toBe(true);
    },
  );

  it('tolerates surrounding whitespace/punctuation and inner whitespace collapse', () => {
    expect(isMarketingOptOutKeyword('  Stop   Marketing.  ')).toBe(true);
    expect(isMarketingOptOutKeyword('"unsubscribe"')).toBe(true);
  });

  it('does not treat a bare "stop" as a marketing-specific keyword (the global handler still owns that)', () => {
    expect(isMarketingOptOutKeyword('stop')).toBe(false);
  });

  it.each([
    "please don't unsubscribe me by mistake",
    'can you stop marketing to my friend instead',
  ])(
    'does not treat %j as a keyword (substring, not the whole message)',
    (text) => {
      expect(isMarketingOptOutKeyword(text)).toBe(false);
    },
  );

  it.each([null, undefined, '', '   '])('returns false for %j', (text) => {
    expect(isMarketingOptOutKeyword(text)).toBe(false);
  });
});
