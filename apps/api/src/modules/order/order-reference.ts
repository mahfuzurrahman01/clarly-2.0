// F25, open question 4: the short, human-quotable order reference.
//
// `ORD-` plus 6 characters of Crockford-style base32 with the ambiguous
// glyphs removed (no I/L/O/U, no 0/1) — a merchant reads this down a phone
// line to a customer, and "ORD-0OI1" is a support ticket waiting to happen.
//
// Uniqueness is the DATABASE's job (`UNIQUE (tenant_id, reference)`), not this
// function's: ~1.07e9 combinations makes a collision rare, and the writer
// retries on the unique violation rather than pretending randomness is a
// guarantee.
import { randomInt } from 'node:crypto';

/** Crockford base32 minus I, L, O, U — 32 glyphs with no ambiguous pair. */
export const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REFERENCE_PREFIX = 'ORD-';
export const REFERENCE_BODY_LENGTH = 6;

/** `ORD-` + 6 unambiguous characters. Cryptographically seeded, so two racing turns do not draw the same value from a seeded PRNG. */
export function generateOrderReference(): string {
  let body = '';
  for (let i = 0; i < REFERENCE_BODY_LENGTH; i += 1) {
    body += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `${REFERENCE_PREFIX}${body}`;
}

/** Shape check, used by the spec and by anything parsing a reference a human typed back at us. */
export function isOrderReference(value: string): boolean {
  if (!value.startsWith(REFERENCE_PREFIX)) return false;
  const body = value.slice(REFERENCE_PREFIX.length);
  if (body.length !== REFERENCE_BODY_LENGTH) return false;
  return [...body].every((char) => REFERENCE_ALPHABET.includes(char));
}
