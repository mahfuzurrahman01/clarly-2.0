// Clarly 2.0 S3: the visitor token.
//
// Autologic's widget identified a visitor by an id the browser made up, so
// anyone who learned (or guessed) another visitor's id could read their
// conversation. Here the API mints the visitor id and signs it: the widget
// keeps `{ visitorId, token }` in the visitor's browser, and every message
// read or write must present a token that is an HMAC of (widget id, visitor
// id). A token for one widget is useless on another.
//
// The HMAC key is derived (HKDF-SHA256) from BSP_CREDENTIALS_ENCRYPTION_KEY
// with a purpose label, so no new secret has to be configured and the
// derived key is never the encryption key itself.
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';

const INFO = 'clarly-widget-visitor-token-v1';

export function deriveWidgetTokenKey(encryptionKeyBase64: string): Buffer {
  const ikm = Buffer.from(encryptionKeyBase64, 'base64');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), INFO, 32));
}

export function newVisitorId(): string {
  return `web_${randomUUID()}`;
}

export function isVisitorId(value: string): boolean {
  return /^web_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
}

export function signVisitor(
  key: Buffer,
  widgetId: string,
  visitorId: string,
): string {
  return createHmac('sha256', key)
    .update(`${widgetId}:${visitorId}`)
    .digest('base64url');
}

export function verifyVisitor(
  key: Buffer,
  widgetId: string,
  visitorId: string,
  token: string,
): boolean {
  if (!isVisitorId(visitorId)) return false;
  const expected = Buffer.from(signVisitor(key, widgetId, visitorId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
