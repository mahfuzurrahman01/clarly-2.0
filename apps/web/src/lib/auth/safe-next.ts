/**
 * Validate a `?next=` redirect target. Only same-origin absolute paths are
 * allowed — rejects protocol-relative (`//evil.com`) and backslash tricks that
 * browsers normalise to a host. Anything invalid falls back to `/home`.
 */
export function safeNext(
  next: string | null | undefined,
  fallback = "/home",
): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
