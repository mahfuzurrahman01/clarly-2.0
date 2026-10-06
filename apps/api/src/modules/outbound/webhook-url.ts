// F11: a tenant-supplied webhook URL is attacker-controlled input that this
// server then makes a request to. That is SSRF by construction unless the
// destination is checked, and "it is our own customer" is not a control — a
// tenant account is a signup form away.
//
// Checked at REGISTRATION and again at DELIVERY. Registration-only validation
// is defeated by a DNS record that resolves publicly today and to 169.254.169.254
// tomorrow, which is the standard way this class of check is bypassed.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeWebhookUrlError extends Error {
  constructor(reason: string) {
    super(`Unsafe webhook URL: ${reason}`);
    this.name = 'UnsafeWebhookUrlError';
  }
}

/** Ranges that must never be reachable from a tenant-configured URL. Cloud metadata (169.254.169.254) is the one that turns SSRF into credential theft. */
function isBlockedAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('::ffff:127.')) return true;
  if (
    address.startsWith('fe80:') ||
    address.startsWith('fc') ||
    address.startsWith('fd')
  ) {
    return true;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    // Anything unparseable is refused rather than assumed safe.
    return !isIP(address);
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

/**
 * @throws UnsafeWebhookUrlError when the URL is malformed, not https, or
 *   resolves to an address inside this network.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError('not a valid URL');
  }

  // https only: the payload carries customer data, and a plaintext POST to a
  // tenant's endpoint would put it on the wire for anyone on the path.
  if (url.protocol !== 'https:') {
    throw new UnsafeWebhookUrlError('must be https');
  }

  if (url.username || url.password) {
    throw new UnsafeWebhookUrlError('must not embed credentials');
  }

  const host = url.hostname;
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new UnsafeWebhookUrlError('resolves inside a private network');
    }
    return;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new UnsafeWebhookUrlError('hostname does not resolve');
  }

  // EVERY address, not just the first: a host that returns one public and one
  // private address would otherwise pass and then be reached on the private
  // one depending on resolver order.
  if (resolved.some((entry) => isBlockedAddress(entry.address))) {
    throw new UnsafeWebhookUrlError('resolves inside a private network');
  }
}
