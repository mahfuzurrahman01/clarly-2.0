// Feature 24 (Store Integrations): the one place that decides whether a
// store-side order belongs to the customer who is asking.
//
// This is the whole security property of order read-back, so it lives in its
// own file with its own tests rather than as a private method: "no customer
// may retrieve another customer's order" (F26 D4, written against exactly
// this risk) is enforced by comparing the store's phone for the order against
// the phone on the platform's OWN `customers` row — never against anything
// the model or the customer typed.
//
// Matching is deliberately lenient about FORMAT and strict about IDENTITY.
// The same person is `+966500000000` in our `customers` table (E.164, from the
// WhatsApp webhook) and very often `0500000000` in a Salla/WooCommerce order,
// because the merchant's checkout form takes a local-format number. An exact
// string compare would make the feature answer "you have no orders" for
// almost every real Gulf merchant. So:
//
//   - non-digits are dropped, and one international/trunk prefix (`00` or a
//     single leading `0`) is stripped;
//   - a match requires at least MIN_SIGNIFICANT_DIGITS digits on BOTH sides,
//     so a truncated or junk store value can never match anybody;
//   - the shorter normalized number must be a full suffix of the longer.
//
// Residual risk, stated rather than hidden: two customers of the same tenant
// whose numbers share a 9-digit suffix would match each other. Within one
// country's numbering plan the subscriber part IS the identity, so this does
// not occur in practice; the alternative (exact match) fails closed so often
// that merchants would route every "where is my order" to a human instead.

/** A national subscriber number in every Gulf numbering plan is at least this long. Below it we refuse to match at all. */
const MIN_SIGNIFICANT_DIGITS = 9;

/** Digits only, with one leading `00` or a single leading trunk `0` removed. */
export function normalizePhoneForMatch(
  value: string | null | undefined,
): string {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * True when both numbers identify the same subscriber. Fails closed on any
 * missing, short, or unparseable value.
 */
export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizePhoneForMatch(a);
  const right = normalizePhoneForMatch(b);
  if (
    left.length < MIN_SIGNIFICANT_DIGITS ||
    right.length < MIN_SIGNIFICANT_DIGITS
  ) {
    return false;
  }
  if (left === right) return true;
  return left.length > right.length
    ? left.endsWith(right)
    : right.endsWith(left);
}
