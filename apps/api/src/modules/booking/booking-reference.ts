import { randomInt } from 'node:crypto';
import { REFERENCE_ALPHABET } from '../order/order-reference';

export const BOOKING_REFERENCE_PREFIX = 'BK-';
const BODY_LENGTH = 6;

/** `BK-` + 6 unambiguous characters (same alphabet as order references). */
export function generateBookingReference(): string {
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    body += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `${BOOKING_REFERENCE_PREFIX}${body}`;
}
