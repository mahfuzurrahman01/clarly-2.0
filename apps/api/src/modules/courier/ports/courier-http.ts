// F26 (Delivery Tracking): the one HTTP helper every courier adapter uses.
//
// DRY, but also a security boundary: it is the single place that turns a
// courier's HTTP response into either a `CourierAuthenticationError` (401/403
// — deactivate the connection, tell the merchant, D8) or a
// `CourierTransportError` (timeout/5xx/garbage — retry, back off, never
// surface on the respond path). An adapter that classified this itself would
// be a fourth place to get it wrong.
import {
  CourierAuthenticationError,
  CourierTransportError,
  type CourierName,
} from './courier-connector.port';

/** Courier APIs are the slowest dependency in the stack; nothing waits on one forever. */
export const COURIER_REQUEST_TIMEOUT_MS = 10_000;

export interface CourierRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Performs the request and returns the parsed JSON body.
 *
 * @throws CourierAuthenticationError on 401/403 — never retried.
 * @throws CourierTransportError on anything else that is not a usable body.
 */
export async function courierFetchJson<T>(
  courier: CourierName,
  request: CourierRequest,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? COURIER_REQUEST_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: { Accept: 'application/json', ...(request.headers ?? {}) },
      body: request.body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new CourierTransportError(
      courier,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new CourierAuthenticationError(courier, `HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new CourierTransportError(courier, `HTTP ${response.status}`);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new CourierTransportError(
      courier,
      `response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Courier timestamps arrive in a dozen shapes and some arrive empty. An
 * unparseable one is NOT an error — the event still happened, we just do not
 * know when — so it falls back to `fallback` (the read time) rather than
 * poisoning the whole batch with a NaN date that would then be written into
 * `occurred_at`, which is part of the history dedup key.
 */
export function parseCourierDate(
  value: unknown,
  fallback: Date = new Date(),
): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Milliseconds vs seconds: anything below ~1e11 cannot be a plausible ms
    // epoch for a parcel (it would be 1973), so it is seconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? fallback : date;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    // Several Gulf courier APIs emit "2026-09-21 14:03:00" with no zone
    // marker. `new Date()` reads that as LOCAL time, which shifts every
    // timestamp by the server's offset; normalizing to an ISO string with an
    // explicit Z keeps stored history comparable across deployments.
    const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)$/.exec(
      value.trim(),
    );
    const candidate = naive ? `${naive[1]}T${naive[2]}Z` : value.trim();
    const date = new Date(candidate);
    return Number.isNaN(date.getTime()) ? fallback : date;
  }
  return fallback;
}

/**
 * First parseable date among the given keys, or `undefined` when none of
 * them are present/parseable — unlike `parseCourierDate`, there is
 * deliberately NO fallback to "now": an estimated-delivery field that is
 * absent means "the courier didn't give us one," and defaulting that to the
 * read time would write a fabricated ETA into `shipments.estimated_delivery_at`,
 * which `track_order` (D4) reads and repeats to the customer verbatim.
 */
export function pickOptionalDate(
  source: Record<string, unknown>,
  ...keys: string[]
): Date | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    const date = parseCourierDate(value, INVALID_DATE);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

const INVALID_DATE = new Date(Number.NaN);

/** Narrow an `unknown` JSON node to a record without reaching for `any`. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** First non-empty string among the given keys — couriers rename fields between API versions and between countries. */
export function pickString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

/** Required credential field, with an error that names what is missing rather than sending an empty string to the courier. */
export function requireCredential(
  courier: CourierName,
  credentials: Record<string, string>,
  key: string,
): string {
  const value = credentials[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CourierAuthenticationError(
      courier,
      `the stored credentials are missing "${key}"`,
    );
  }
  return value.trim();
}
