// Platform (CoreModule): what QUEUE_PROFILE=lean changes at the env layer.
//
// Every BullMQ repeat schedule below already has its own *_INTERVAL_MS var;
// a profile only swaps the DEFAULT used when that var is unset, so an
// operator's explicit setting always wins. Applied before schema parsing so
// zod still validates the final values and the normal defaults stay the
// single source of truth for QUEUE_PROFILE=default (zero behaviour change).
//
// Why these and not the daily sweeps: each scheduled run costs a handful of
// Redis commands (promote, move-to-active, finish, schedule-next), so the
// 1-minute and 5-15-minute sweeps dominate a metered Redis bill while the
// daily ones are noise. Bounds kept:
// - TOOL_SCOPE_VIOLATION: interval must not exceed its 5-minute detection
//   window (TOOL_SCOPE_VIOLATION_CHECK_WINDOW_MINUTES), or violations that
//   fall between two checks are never counted. 5 minutes = window.
// - LATENCY: window is 15 minutes, so a 5-minute interval keeps overlap.
// - Stuck-ticket / platform-health are state checks (no window), so a
//   5-minute cadence only makes an alert up to 5 minutes later.
export const QUEUE_PROFILES = ['default', 'lean'] as const;
export type QueueProfile = (typeof QUEUE_PROFILES)[number];

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const LEAN_INTERVAL_DEFAULTS_MS: Readonly<Record<string, number>> = {
  STUCK_TICKET_CHECK_INTERVAL_MS: FIVE_MINUTES_MS,
  LATENCY_CHECK_INTERVAL_MS: FIVE_MINUTES_MS,
  PLATFORM_HEALTH_CHECK_INTERVAL_MS: FIVE_MINUTES_MS,
  TOOL_SCOPE_VIOLATION_CHECK_INTERVAL_MS: FIVE_MINUTES_MS,
  AUTO_CLOSE_CHECK_INTERVAL_MS: THIRTY_MINUTES_MS,
  SHIPMENT_POLL_INTERVAL_MS: THIRTY_MINUTES_MS,
  STORE_SYNC_INTERVAL_MS: ONE_HOUR_MS,
};

/**
 * Returns a copy of `source` with the lean interval defaults filled in for
 * every interval var that is unset, when QUEUE_PROFILE is exactly 'lean'.
 * Any other value (including invalid ones) passes through untouched and is
 * rejected by the schema's enum.
 */
export function applyQueueProfileDefaults(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (source.QUEUE_PROFILE !== 'lean') {
    return source;
  }
  const unsetDefaults = Object.entries(LEAN_INTERVAL_DEFAULTS_MS)
    .filter(([key]) => source[key] === undefined)
    .map(([key, ms]) => [key, String(ms)] as const);
  return { ...source, ...Object.fromEntries(unsetDefaults) };
}
