// Clarly 2.0 S3: which websites may load a tenant's widget.
//
// Origins are compared EXACTLY (scheme + host + port), after normalising
// case and a default port. No wildcards: `*.example.com` would also admit
// `attacker.example.com.evil.net`-style mistakes in a hand-rolled matcher,
// and a tenant with several shops lists each one.

/** `https://Shop.Example.com:443/` → `https://shop.example.com`; null if not an http(s) origin. */
export function normaliseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const port =
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80') ||
    url.port === ''
      ? ''
      : `:${url.port}`;
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}

/** Plain http is only allowed for local development hosts. */
export function isAcceptableOrigin(origin: string): boolean {
  const normalised = normaliseOrigin(origin);
  if (!normalised) return false;
  if (normalised.startsWith('https://')) return true;
  const host = new URL(normalised).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

export function isOriginAllowed(
  requestOrigin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (!requestOrigin) return false;
  const normalised = normaliseOrigin(requestOrigin);
  if (!normalised) return false;
  return allowed.some((entry) => normaliseOrigin(entry) === normalised);
}
