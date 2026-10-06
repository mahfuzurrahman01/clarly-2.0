// F26 (Delivery Tracking): the resilience wrapper D2 requires around every
// adapter call — bounded retry plus a per-key circuit breaker.
//
// D2 says "the same circuit-breaker + bounded-retry wrapper used for store
// adapters". No such wrapper exists in `store/` today (its adapters call
// `fetch` directly), so this is that wrapper, written here because F26 is the
// feature that cannot ship without it: courier APIs are the slowest and least
// reliable dependency in the stack, and a hung Aramex call must never end up
// on a request path.
//
// Deliberately in-process and in-memory, like `AlertDebouncer`: the breaker's
// job is to stop ONE replica from hammering a courier that is already down,
// not to be a distributed consensus. A per-replica breaker is strictly better
// than none and has no failure mode of its own.
//
// `CourierAuthenticationError` is never retried and never counts toward the
// breaker: bad credentials are not a transient failure, and retrying them is
// how an account gets locked out.
import { CourierAuthenticationError } from './ports/courier-connector.port';

export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_HALF_OPEN_AFTER_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 250;

export class CourierCircuitOpenError extends Error {
  constructor(key: string) {
    super(
      `Circuit breaker is open for "${key}" — the courier has failed ${CIRCUIT_FAILURE_THRESHOLD} consecutive calls; not calling it again yet.`,
    );
    this.name = 'CourierCircuitOpenError';
  }
}

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface CourierCallOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Injectable for tests — the real one is `Date.now`. */
  now?: () => number;
  /** Injectable for tests — the real one is a `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One breaker per key. The key is `${courier}:${connectionId}` at the call
 * sites, so one merchant's bad account cannot open the breaker for every
 * other merchant on the same courier.
 */
export class CourierCallGuard {
  private readonly circuits = new Map<string, CircuitState>();

  async run<T>(
    key: string,
    fn: () => Promise<T>,
    options: CourierCallOptions = {},
  ): Promise<T> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

    if (this.isOpen(key, now())) {
      throw new CourierCircuitOpenError(key);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await fn();
        this.circuits.delete(key);
        return result;
      } catch (error) {
        // Credentials are not a transient condition. Surface immediately,
        // leave the breaker untouched, and let D8's "deactivate the
        // connection and tell the merchant" path handle it.
        if (error instanceof CourierAuthenticationError) throw error;

        lastError = error;
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    this.recordFailure(key, now());
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'unknown courier failure'));
  }

  /** Test/ops helper. */
  isOpen(key: string, at: number = Date.now()): boolean {
    const circuit = this.circuits.get(key);
    if (!circuit || circuit.openedAt === null) return false;
    if (at - circuit.openedAt >= CIRCUIT_HALF_OPEN_AFTER_MS) {
      // Half-open: let exactly one attempt through. A success clears the
      // circuit entirely, a failure re-opens it with a fresh timestamp.
      this.circuits.set(key, {
        consecutiveFailures: circuit.consecutiveFailures,
        openedAt: null,
      });
      return false;
    }
    return true;
  }

  private recordFailure(key: string, at: number): void {
    const circuit = this.circuits.get(key) ?? {
      consecutiveFailures: 0,
      openedAt: null,
    };
    const consecutiveFailures = circuit.consecutiveFailures + 1;
    this.circuits.set(key, {
      consecutiveFailures,
      openedAt:
        consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD
          ? at
          : circuit.openedAt,
    });
  }

  /** Test helper — drops all breaker state. */
  reset(): void {
    this.circuits.clear();
  }
}
