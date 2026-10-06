import {
  isAcceptableOrigin,
  isOriginAllowed,
  normaliseOrigin,
} from './widget-origin';

describe('widget origins', () => {
  it('normalises case, default ports and trailing paths', () => {
    expect(normaliseOrigin('HTTPS://Shop.Example.com:443/products?x=1')).toBe(
      'https://shop.example.com',
    );
    expect(normaliseOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
  });

  it.each([
    'javascript:alert(1)',
    'ftp://example.com',
    'not a url',
    'https://user:pw@example.com',
  ])('rejects %s', (value) => expect(normaliseOrigin(value)).toBeNull());

  it('accepts https anywhere and http only on localhost', () => {
    expect(isAcceptableOrigin('https://shop.example.com')).toBe(true);
    expect(isAcceptableOrigin('http://localhost:5173')).toBe(true);
    expect(isAcceptableOrigin('http://shop.example.com')).toBe(false);
  });

  it('matches exactly — no suffix or subdomain tricks', () => {
    const allowed = ['https://shop.example.com'];
    expect(isOriginAllowed('https://shop.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://evil-shop.example.com', allowed)).toBe(
      false,
    );
    expect(isOriginAllowed('https://shop.example.com.evil.net', allowed)).toBe(
      false,
    );
    expect(isOriginAllowed('http://shop.example.com', allowed)).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
    expect(isOriginAllowed('https://shop.example.com', [])).toBe(false);
  });
});
