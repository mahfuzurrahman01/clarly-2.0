// Channel (MetaChannelModule, Gulf T6 / D9): which URLs a Messenger/Instagram
// attachment may be fetched from.
//
// The URL comes out of a webhook body. The body is signed by Meta, but the
// URL inside it is still the one input where a mistake turns into SSRF: this
// worker runs inside our network and would happily GET whatever it is handed.
// So the rule is an allowlist of Meta's attachment CDNs, checked on the parsed
// URL (never with a regex over the raw string), and anything else is refused
// before a socket is opened.
//
// Rules, each one closing a specific bypass:
//   - https only. No http (downgrade), no file:/data:/gopher: (local reads).
//   - hostname matched by EXACT host or by a suffix that starts with a dot,
//     so `evilfbcdn.net` and `fbcdn.net.evil.com` do not match `*.fbcdn.net`.
//   - no userinfo (`https://scontent.fbcdn.net@169.254.169.254/` parses with
//     the attacker's host, and a userinfo-bearing url has no business here).
//   - default port only. A CDN never needs another one; an internal service
//     reached through a suffix trick would.
//   - redirects are refused by the fetcher (`redirect: 'error'`), so the host
//     checked here is the only host ever contacted.
// IP-literal hosts can never match a suffix, and WHATWG URL parsing
// lowercases and punycodes the hostname before the comparison runs.

/** Hosts matched exactly. */
const EXACT_HOSTS: readonly string[] = ['lookaside.fbsbx.com'];

/** Subdomains of these match (`*.fbcdn.net`); the bare apex does not. */
const SUFFIX_HOSTS: readonly string[] = ['.fbcdn.net', '.cdninstagram.com'];

/** For log lines and the HANDOFF doc: the allowlist as written in D9. */
export const SOCIAL_MEDIA_HOST_ALLOWLIST: readonly string[] = [
  ...SUFFIX_HOSTS.map((suffix) => `*${suffix}`),
  ...EXACT_HOSTS,
];

function isAllowedHost(hostname: string): boolean {
  if (EXACT_HOSTS.includes(hostname)) return true;
  return SUFFIX_HOSTS.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
}

/**
 * Parses `raw` and returns it only if it is safe to fetch without
 * credentials; null otherwise. Pure, so every bypass above is a unit test.
 */
export function parseAllowedSocialMediaUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (!isAllowedHost(url.hostname)) return null;
  return url;
}
