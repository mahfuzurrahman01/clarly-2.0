// F26 (Delivery Tracking): the shared fallback half of status mapping.
//
// Each adapter owns an explicit table of its courier's own status CODES —
// that table is the contract, and the recorded-fixture contract tests
// (`test:courier-contract`) exist so that a vendor changing a code is a
// failing test rather than a silent `unknown`.
//
// This keyword pass runs ONLY when the code table has no entry. It is not a
// substitute for the table: it exists because a courier that adds a new code
// mid-quarter should degrade to a plausible status rather than telling every
// customer "unknown", and because several of these APIs ship a description
// with no code at all on some event types.
//
// Order matters — the first match wins, so the more specific phrases come
// first ("out for delivery" before "delivery", "delivery attempt" before
// "delivered" never matches the wrong way round).
import type { ShipmentStatus } from './courier-connector.port';

const KEYWORD_RULES: ReadonlyArray<
  readonly [readonly string[], ShipmentStatus]
> = [
  [['out for delivery', 'with courier', 'with driver'], 'out_for_delivery'],
  [
    [
      'delivery attempt',
      'attempted delivery',
      'failed attempt',
      'undelivered',
      'consignee not available',
      'customer not available',
    ],
    'failed_attempt',
  ],
  [['delivered', 'signed for', 'signed by', 'pod'], 'delivered'],
  [['returned to shipper', 'return to shipper', 'returned', 'rts'], 'returned'],
  [['cancelled', 'canceled', 'void'], 'cancelled'],
  [
    ['picked up', 'pickup scan', 'collected from shipper', 'collected'],
    'picked_up',
  ],
  [
    [
      'in transit',
      'arrived at',
      'departed',
      'transferred',
      'dispatch scan',
      'arrival scan',
      'at facility',
      'at hub',
      'sorting',
    ],
    'in_transit',
  ],
  [
    ['shipment created', 'label created', 'record created', 'awb created'],
    'label_created',
  ],
  [
    ['exception', 'held', 'on hold', 'customs', 'damaged', 'lost', 'problem'],
    'exception',
  ],
];

/**
 * Best-effort status for a courier description. Returns `null` — not
 * `'unknown'` — when nothing matches, so the caller can tell "no keyword rule
 * applied" from "this genuinely is an unknown status" and log accordingly.
 */
export function statusFromKeywords(
  description: string | undefined,
): ShipmentStatus | null {
  if (!description) return null;
  const haystack = description.toLowerCase();
  for (const [phrases, status] of KEYWORD_RULES) {
    if (phrases.some((phrase) => haystack.includes(phrase))) return status;
  }
  return null;
}
