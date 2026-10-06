// Privacy (PrivacyModule, Gulf T7 / D7): verification of the `signed_request`
// Meta POSTs to the Data Deletion Request and Deauthorize callbacks.
//
// Format, per Meta's Data Deletion Request Callback reference
// (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback):
//
//   signed_request = base64url(HMAC-SHA256(appSecret, encodedPayload)) + "." + encodedPayload
//   payload        = { algorithm: "HMAC-SHA256", user_id, issued_at, expires? }
//
// Three properties this file holds, each against a specific attack:
//   - The MAC is computed over the ENCODED payload string exactly as received
//     (that is what Meta signs), and checked BEFORE the payload is decoded or
//     parsed — nothing about an unauthenticated request is interpreted.
//   - The comparison is constant-time (`timingSafeEqual`) over the raw 32-byte
//     digests, so response timing reveals nothing about how close a forgery is.
//   - `algorithm` must be HMAC-SHA256 even though the MAC already verified.
//     Meta's own sample omits this check; the Facebook SDKs have always done
//     it, and it costs nothing — if Meta ever introduced a second algorithm,
//     silently treating it as the first is the failure mode to avoid.
//
// Pure function, no Nest DI: the secret is passed in, which is what makes the
// spec able to exercise every rejection path without a config service.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Well above any real signed_request (a few hundred bytes); bounds the HMAC work an unauthenticated caller can make us do. */
const MAX_SIGNED_REQUEST_LENGTH = 8192;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
/** App-scoped user ids are decimal strings. Anything else is not something Meta sent. */
const APP_SCOPED_USER_ID = /^[0-9]{1,32}$/;
const EXPECTED_ALGORITHM = 'HMAC-SHA256';
const SHA256_BYTES = 32;

export type InvalidSignedRequestKind =
  'malformed' | 'signature' | 'algorithm' | 'not_configured';

export class InvalidSignedRequestError extends Error {
  constructor(
    readonly kind: InvalidSignedRequestKind,
    detail: string,
  ) {
    super(`Invalid Meta signed_request (${kind}): ${detail}`);
    this.name = 'InvalidSignedRequestError';
  }
}

export interface MetaSignedRequest {
  /** The app-scoped user id (ASID) the request is about. */
  userId: string;
  /** When Meta issued the request, if it said. Recorded, never trusted for authorization. */
  issuedAt: Date | null;
}

/**
 * @throws InvalidSignedRequestError on any failure — the caller's single
 *   catch is the only rejection path.
 */
export function parseMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
): MetaSignedRequest {
  if (!appSecret) {
    throw new InvalidSignedRequestError(
      'not_configured',
      'no Meta app secret is configured',
    );
  }
  if (
    signedRequest.length === 0 ||
    signedRequest.length > MAX_SIGNED_REQUEST_LENGTH
  ) {
    throw new InvalidSignedRequestError('malformed', 'bad length');
  }

  const separator = signedRequest.indexOf('.');
  const encodedSig = signedRequest.slice(0, Math.max(separator, 0));
  const encodedPayload = signedRequest.slice(separator + 1);
  if (
    separator <= 0 ||
    !BASE64URL.test(encodedSig) ||
    !BASE64URL.test(encodedPayload)
  ) {
    throw new InvalidSignedRequestError(
      'malformed',
      'expected <base64url sig>.<base64url payload>',
    );
  }

  verifySignature(encodedSig, encodedPayload, appSecret);

  const payload = decodePayload(encodedPayload);
  const algorithm = payload.algorithm;
  if (
    typeof algorithm !== 'string' ||
    algorithm.toUpperCase() !== EXPECTED_ALGORITHM
  ) {
    throw new InvalidSignedRequestError(
      'algorithm',
      `expected ${EXPECTED_ALGORITHM}`,
    );
  }

  const rawUserId = payload.user_id;
  const userId =
    typeof rawUserId === 'number' && Number.isSafeInteger(rawUserId)
      ? String(rawUserId)
      : rawUserId;
  if (typeof userId !== 'string' || !APP_SCOPED_USER_ID.test(userId)) {
    throw new InvalidSignedRequestError(
      'malformed',
      'user_id missing or not an app-scoped id',
    );
  }

  const issuedAt = payload.issued_at;
  return {
    userId,
    issuedAt:
      typeof issuedAt === 'number' && Number.isFinite(issuedAt)
        ? new Date(issuedAt * 1000)
        : null,
  };
}

function verifySignature(
  encodedSig: string,
  encodedPayload: string,
  appSecret: string,
): void {
  const provided = Buffer.from(encodedSig, 'base64url');
  const expected = createHmac('sha256', appSecret)
    .update(encodedPayload)
    .digest();
  // Length is a public constant (32), so the short-circuit leaks nothing.
  if (
    provided.length !== SHA256_BYTES ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new InvalidSignedRequestError('signature', 'HMAC mismatch');
  }
}

function decodePayload(encodedPayload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
  } catch {
    throw new InvalidSignedRequestError('malformed', 'payload is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidSignedRequestError(
      'malformed',
      'payload is not a JSON object',
    );
  }
  return parsed as Record<string, unknown>;
}
