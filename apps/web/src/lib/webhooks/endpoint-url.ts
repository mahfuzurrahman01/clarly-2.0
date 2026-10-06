export type EndpointUrlProblem = "invalid" | "https" | "private";

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 literals arrive bracketed; any of them is a raw address, not a public host name.
  if (host.startsWith("[")) return true;
  return PRIVATE_IPV4.some((range) => range.test(host));
}

/**
 * Client-side pre-check for a webhook endpoint, so "Add endpoint" never posts
 * something the delivery worker will refuse. The API stays the authority (it
 * also resolves DNS before delivering); this only catches what is knowable
 * from the string: not a URL, not https, or a local/private address.
 */
export function endpointUrlProblem(raw: string): EndpointUrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:") return "https";
  // "https://foo" parses, but a single-label host can't be reached from the internet.
  if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) {
    return url.hostname === "localhost" ? "private" : "invalid";
  }
  if (isPrivateHost(url.hostname)) return "private";
  return null;
}
