// F26 (Delivery Tracking): the courier port — D2.
//
// Modelled directly on the corrected `StoreProvider` port: an abstract class
// as the DI shape, one concrete adapter per courier, a no-op that fails
// closed, and a registry that maps `connection.courier` -> adapter at runtime.
//
// The port is PER CONNECTION, not per deployment. One deployment serves an
// Aramex merchant and an SMSA merchant at the same time, so there is no
// boot-time provider enum and no `COURIER_PROVIDER` env var.
//
// Two rules the whole feature rests on:
//   - Courier status strings are mapped INTO `ShipmentStatus`. Nothing
//     downstream ever reads a courier's own status text.
//   - `rawStatus` and every other courier-controlled string is stored for
//     support but never reaches the model (D4). F26's entire input surface is
//     third-party strings, and a third-party string rendered into a prompt is
//     a prompt-injection surface.
import {
  COURIER_NAMES,
  SHIPMENT_STATUSES,
  type CourierName,
  type ShipmentStatus,
} from '../../persistence/drizzle/schema';

export { COURIER_NAMES, SHIPMENT_STATUSES };
export type { CourierName, ShipmentStatus };

export function isCourierName(value: string): value is CourierName {
  return (COURIER_NAMES as readonly string[]).includes(value);
}

export interface CourierStatusEvent {
  status: ShipmentStatus;
  /** The courier's own status code, kept for support/debugging. NEVER shown to the model (D4). */
  rawStatus: string;
  occurredAt: Date;
  /** City/hub name only, from a courier-controlled field — treated as untrusted (D4). */
  location?: string;
}

export interface CourierTrackingResult {
  trackingNumber: string;
  currentStatus: ShipmentStatus;
  estimatedDeliveryAt?: Date;
  events: CourierStatusEvent[];
}

export type CourierWebhookHeaders = Record<string, string | undefined>;

/**
 * Thrown by an adapter when the courier rejected our credentials (401/403).
 * Distinct from a transport failure because D8 gives them opposite handling:
 * a transport failure is retried and backed off, a credential failure
 * deactivates the connection and tells the merchant.
 */
export class CourierAuthenticationError extends Error {
  constructor(courier: CourierName, detail: string) {
    super(`${courier} rejected the stored credentials: ${detail}`);
    this.name = 'CourierAuthenticationError';
  }
}

/** Thrown for a timeout, a 5xx, or an unparseable body — retryable. */
export class CourierTransportError extends Error {
  constructor(courier: CourierName, detail: string) {
    super(`${courier} request failed: ${detail}`);
    this.name = 'CourierTransportError';
  }
}

export abstract class CourierConnector {
  abstract readonly courier: CourierName;

  /**
   * Cheap authenticated call used by D1's activation check. Throws
   * `CourierAuthenticationError` on bad credentials, resolves otherwise —
   * tracking a known-bad AWB is enough, because all we need to learn is
   * "authenticated" vs "rejected".
   */
  abstract verifyCredentials(
    credentials: Record<string, string>,
  ): Promise<void>;

  /** Batch where the courier supports it (Aramex `TrackShipments` takes an array); one call per AWB otherwise. */
  abstract track(
    credentials: Record<string, string>,
    trackingNumbers: string[],
  ): Promise<CourierTrackingResult[]>;

  /** null = this courier has no push surface we accept (Aramex/SMSA/Naqel). The webhook route rejects those up front (D6 step 1). */
  abstract readonly webhookSignatureHeader: string | null;

  abstract verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
    secret: string,
  ): boolean;

  abstract extractEventId(
    payload: unknown,
    headers: CourierWebhookHeaders,
  ): string | null;

  abstract normalizeWebhookEvent(
    payload: unknown,
    headers: CourierWebhookHeaders,
  ): { trackingNumber: string; events: CourierStatusEvent[] } | null;
}

/**
 * Forward order of the status lifecycle, used by D5's terminal-status guard:
 * couriers replay old events, and a `delivered -> in_transit` regression is
 * recorded in history but ignored for notification purposes.
 *
 * `exception` and `unknown` sit outside the ladder — they are not progress in
 * either direction, so they never satisfy "moved forward".
 */
const STATUS_RANK: Readonly<Record<ShipmentStatus, number>> = {
  label_created: 0,
  picked_up: 1,
  in_transit: 2,
  out_for_delivery: 3,
  failed_attempt: 4,
  delivered: 5,
  returned: 5,
  cancelled: 5,
  exception: -1,
  unknown: -1,
};

export function isForwardTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): boolean {
  const fromRank = STATUS_RANK[from];
  const toRank = STATUS_RANK[to];
  if (fromRank < 0 || toRank < 0) return false;
  return toRank > fromRank;
}

export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  'delivered',
  'returned',
  'cancelled',
]);

export function isTerminalStatus(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
