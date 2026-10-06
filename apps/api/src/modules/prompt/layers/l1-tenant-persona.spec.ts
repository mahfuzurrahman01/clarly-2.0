import {
  renderL1TenantPersona,
  sanitizeTenantPersona,
} from './l1-tenant-persona';

describe('sanitizeTenantPersona()', () => {
  it('returns an empty string for null', () => {
    expect(sanitizeTenantPersona(null)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTenantPersona('  friendly and concise  ')).toBe(
      'friendly and concise',
    );
  });

  it('strips control characters but keeps tabs and newlines', () => {
    const withControlChars =
      'friendly\x00\x07 and\x1F concise\tokay\nnext line';
    expect(sanitizeTenantPersona(withControlChars)).toBe(
      'friendly and concise\tokay\nnext line',
    );
  });

  it('caps length at 500 characters', () => {
    const long = 'a'.repeat(600);
    expect(sanitizeTenantPersona(long)).toHaveLength(500);
  });
});

describe('renderL1TenantPersona()', () => {
  it('returns an empty string when there is no persona (fixed slot, but omitted from the assembled prompt when empty)', () => {
    expect(renderL1TenantPersona(null)).toBe('');
  });

  it('renders a labeled section for a sanitized persona', () => {
    expect(renderL1TenantPersona('Friendly and concise.')).toBe(
      '## Persona and tone\nFriendly and concise.',
    );
  });
});
