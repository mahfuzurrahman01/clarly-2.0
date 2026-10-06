// F25 D6.2: the two hashes that make "exactly one order" a database fact
// rather than a hope. Pure functions in their own file, per D9, so every
// stability and sensitivity property below is testable with no DB and no
// mocks.
//
// TWO hashes, because they close two DIFFERENT races:
//
//   idempotency_key = sha256(tenant | conversation | turn | items | phone)
//     Race #1 — the model calls create_order twice in one turn, or the loop
//     retries a malformed call.
//     Race #2 — the respond-path BullMQ job retries after the order was
//     written but before the reply was sent. `turnId` is the coalesced
//     inbound batch's own job id and is STABLE across attempts, so attempt 2
//     derives the same key and finds the existing row.
//
//   content_hash = sha256(tenant | conversation | items | phone | contact)
//     Race #3 — two turns in the same conversation race ("yes" sent twice).
//     It EXCLUDES turnId on purpose: that omission is exactly what makes it
//     catch a *different* turn ordering the same thing, via the partial
//     unique index on (tenant_id, conversation_id, content_hash) WHERE
//     status = 'pending_approval'.
//
// Canonicalisation rules, each one a race that would otherwise stay open:
//   - items are sorted by productId and quantities for a repeated productId
//     are summed, so `[A×1, B×2]` and `[B×2, A×1]` and `[A×1, B×1, B×1]` are
//     one order, not three;
//   - the phone is reduced to its digits (with a leading `+` preserved as
//     nothing, since `00` and `+` prefixes are both common in the Gulf), so
//     "+966 50 123 4567" and "0966501234567" do not open two orders;
//   - free text is trimmed and case-folded before hashing, so a re-typed
//     address with different capitalisation is not a new order.
import { createHash } from 'node:crypto';

export interface IdempotencyItemInput {
  productId: string;
  quantity: number;
}

export interface OrderIdempotencyInput {
  tenantId: string;
  conversationId: string | null;
  turnId: string | null;
  items: readonly IdempotencyItemInput[];
  contactPhone: string;
}

export interface OrderContentInput extends Omit<
  OrderIdempotencyInput,
  'turnId'
> {
  contactName: string;
  address: string;
  city?: string | null;
}

/** Digits only — "+966 50 123 4567", "00966501234567" and "0501234567" must not be three different orders. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // Both international prefixes reduce to the same national+country digits.
  return digits.replace(/^00/, '');
}

/** Sorted by productId with duplicate lines summed — ordering and splitting are not new orders. */
export function canonicalizeItems(
  items: readonly IdempotencyItemInput[],
): string {
  const merged = new Map<string, number>();
  for (const item of items) {
    const key = item.productId.trim().toLowerCase();
    merged.set(key, (merged.get(key) ?? 0) + item.quantity);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, quantity]) => `${productId}:${quantity}`)
    .join(',');
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `\u0000` as the separator, not `|`: a separator a caller could smuggle
 * inside a field would let two different inputs produce one hash. A NUL byte
 * cannot appear in a Postgres `text` column at all, so it cannot appear in any
 * value reaching here.
 */
function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * Stable for the whole of one turn, across every retry of that turn's job.
 * Changes when the tenant, conversation, turn, item set or customer phone
 * changes — and nothing else.
 */
export function deriveIdempotencyKey(input: OrderIdempotencyInput): string {
  return digest([
    'order-idempotency-v1',
    input.tenantId,
    input.conversationId ?? '',
    input.turnId ?? '',
    canonicalizeItems(input.items),
    normalizePhone(input.contactPhone),
  ]);
}

/**
 * Deliberately turn-INDEPENDENT (D6.2 race #3). Two different turns in one
 * conversation ordering the same items to the same address produce the same
 * content hash, and the partial unique index refuses the second pending row.
 */
export function deriveContentHash(input: OrderContentInput): string {
  return digest([
    'order-content-v1',
    input.tenantId,
    input.conversationId ?? '',
    canonicalizeItems(input.items),
    normalizePhone(input.contactPhone),
    normalizeText(input.contactName),
    normalizeText(input.address),
    normalizeText(input.city),
  ]);
}
