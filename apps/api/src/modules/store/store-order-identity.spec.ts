// F24 order read-back: the identity predicate is the security boundary, so
// it gets adversarial tests of its own — a false positive here is one
// customer reading another customer's order.
import { normalizePhoneForMatch, phonesMatch } from './store-order-identity';

describe('normalizePhoneForMatch', () => {
  it('keeps digits only', () => {
    expect(normalizePhoneForMatch('+966 50 000 0000')).toBe('966500000000');
  });

  it('strips an international 00 prefix', () => {
    expect(normalizePhoneForMatch('00966500000000')).toBe('966500000000');
  });

  it('strips a single national trunk zero', () => {
    expect(normalizePhoneForMatch('0500000000')).toBe('500000000');
  });

  it('is empty for null/undefined/garbage', () => {
    expect(normalizePhoneForMatch(null)).toBe('');
    expect(normalizePhoneForMatch(undefined)).toBe('');
    expect(normalizePhoneForMatch('n/a')).toBe('');
  });
});

describe('phonesMatch', () => {
  it('matches E.164 against the local format the merchant checkout stored', () => {
    expect(phonesMatch('+966500000000', '0500000000')).toBe(true);
  });

  it('matches identical numbers', () => {
    expect(phonesMatch('+966500000000', '966500000000')).toBe(true);
  });

  it('does not match two different subscribers', () => {
    expect(phonesMatch('+966500000000', '+966511111111')).toBe(false);
  });

  it('does not match a different country code on the same subscriber part', () => {
    // 971... vs 966... — the suffix differs, so this is a non-match.
    expect(phonesMatch('+966500000000', '+971521111111')).toBe(false);
  });

  it('fails closed on a missing store-side phone', () => {
    expect(phonesMatch('+966500000000', null)).toBe(false);
    expect(phonesMatch('+966500000000', '')).toBe(false);
  });

  it('fails closed on a too-short value rather than matching loosely', () => {
    // '0000' is a suffix of '966500000000' but carries no identity.
    expect(phonesMatch('+966500000000', '0000')).toBe(false);
  });

  it('refuses to match when the caller side is short', () => {
    expect(phonesMatch('1234', '+966500000000')).toBe(false);
  });
});
