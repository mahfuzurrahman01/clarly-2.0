/** Minutes since an ISO timestamp. */
export function minutesSince(iso: string, now: number = Date.now()): number {
  return Math.floor((now - new Date(iso).getTime()) / 60_000);
}

/** An OPEN ticket older than the tenant's threshold is "stuck". */
export function isStuck(
  ticket: { status: string; createdAt: string },
  thresholdMinutes: number,
  now: number = Date.now(),
): boolean {
  return (
    ticket.status === "OPEN" &&
    minutesSince(ticket.createdAt, now) >= thresholdMinutes
  );
}

/** 0–1 confidence → a rounded percentage string, or null. */
export function confidencePct(confidence: number | null): string | null {
  if (confidence === null) return null;
  return `${Math.round(confidence * 100)}%`;
}
