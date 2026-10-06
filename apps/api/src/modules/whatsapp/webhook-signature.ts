// Channel (WhatsappModule): HMAC-SHA256 webhook signature verification.
//
// Meta signs with `X-Hub-Signature-256: sha256=<hex>` keyed by the app
// secret. The header name and the secret stay in the adapter; this file
// owns the crypto so there is exactly one comparison implementation to
// audit.
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Case-insensitive header lookup. Node lowercases incoming header names,
 * but callers building this map by hand (tests, other transports) may not.
 * A `sha256=` prefix is stripped — Meta always sends one; tolerating its
 * absence avoids a silent total-rejection failure mode.
 */
export function findSignatureHeader(
  headers: Record<string, string>,
  headerName: string,
): string | undefined {
  const wanted = headerName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) {
      return value.replace(/^sha256=/i, '').trim();
    }
  }
  return undefined;
}

/**
 * Verifies `provided` against an HMAC-SHA256 of `rawBody` under `secret`.
 *
 * Fails closed on every ambiguity — empty secret, empty signature, length
 * mismatch, undecodable value — returning false rather than throwing, so a
 * caller's single `if (!verify)` check is the only rejection path.
 *
 * The signature is compared against BOTH the hex and base64 encodings of
 * the digest. Meta documents hex; the base64 branch dates from
 * the removed 360dialog adapter (D14), whose docs never stated an encoding.
 * Accepting either costs nothing cryptographically: both comparisons are
 * against the same HMAC under the same secret, so a forger must still
 * produce a valid MAC. The base64 branch can be dropped once live Meta
 * traffic has confirmed hex-only; kept for now to avoid a behavior change
 * in a removal-only task.
 */
export function verifyHmacSha256(
  rawBody: string | Buffer,
  provided: string | undefined,
  secret: string,
): boolean {
  if (!secret || !provided) {
    return false;
  }

  const digest = createHmac('sha256', secret).update(rawBody).digest();
  return (
    constantTimeMatches(provided, digest.toString('hex')) ||
    constantTimeMatches(provided, digest.toString('base64'))
  );
}

/** Compares without leaking match position. Length mismatch short-circuits — not a meaningful timing leak, since the digest length is a public constant. */
function constantTimeMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
