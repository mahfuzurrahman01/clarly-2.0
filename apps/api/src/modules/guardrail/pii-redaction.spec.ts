import { redactPii } from './pii-redaction';

describe('redactPii()', () => {
  it('redacts an email address', () => {
    expect(redactPii('Contact me at jane.doe@example.com please')).toBe(
      'Contact me at [REDACTED_EMAIL] please',
    );
  });

  it('redacts a phone number', () => {
    expect(redactPii('Call me at 555-123-4567')).toContain('[REDACTED_PHONE]');
  });

  it('redacts a credit-card-shaped digit run', () => {
    expect(redactPii('Card: 4111 1111 1111 1111')).toContain('[REDACTED_CARD]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactPii('Your order ships in 3-5 days.')).toBe(
      'Your order ships in 3-5 days.',
    );
  });

  it('does not redact short numbers that are not phone-shaped (e.g. an order count)', () => {
    expect(redactPii('You have 3 items in your cart')).toBe(
      'You have 3 items in your cart',
    );
  });

  it('redacts multiple PII items in the same string', () => {
    const result = redactPii('Email jane@example.com or call 555-123-4567');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).toContain('[REDACTED_PHONE]');
  });
});
