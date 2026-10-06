// F19 (D3, Open Question 1): what one campaign message is estimated to cost.
//
// Pure and dependency-free on purpose — it is the one input F19 cannot
// derive from the codebase, so it is a single exported table with a
// "last checked" date rather than a value scattered through the sender.
//
// The Tech Provider model (D14/D16) means META BILLS THE TENANT'S OWN WABA,
// not us. So this number never appears on an invoice we issue; it exists to
// enforce `campaigns.spend_cap_usd` — the merchant's own stated ceiling on
// what a broadcast may cost them. Every API response labels it "estimated"
// for that reason.
//
// Refreshing the table is a founder/pricing task (Phase 4 unit economics),
// not an engineering blocker: the fallback below is deliberately the highest
// rate in the table, so an unrecognised prefix OVER-estimates. Over-estimating
// pauses a campaign early, which a merchant can fix by raising the cap;
// under-estimating silently overspends their money, which they cannot undo.

/** When MARKETING_RATE_USD_BY_PREFIX was last reconciled against Meta's published rate card. */
export const CAMPAIGN_RATES_LAST_CHECKED = '2026-09-21';

/**
 * Meta marketing-conversation rates, USD, keyed on E.164 country calling
 * code. GCC first (the launch market), then the other prefixes a Gulf
 * merchant's customer list actually carries.
 *
 * Longest-prefix wins, so a future 3-digit entry can override a 1-digit one
 * without restructuring the table.
 */
export const MARKETING_RATE_USD_BY_PREFIX: Readonly<Record<string, number>> = {
  // ---- GCC ----
  '966': 0.0432, // Saudi Arabia
  '971': 0.0344, // United Arab Emirates
  '965': 0.0364, // Kuwait
  '974': 0.0742, // Qatar
  '973': 0.04, // Bahrain
  '968': 0.044, // Oman
  // ---- Neighbouring / diaspora markets on the same lists ----
  '20': 0.1073, // Egypt
  '962': 0.04, // Jordan
  '961': 0.04, // Lebanon
  '90': 0.0057, // Turkey
  '91': 0.0099, // India
  '92': 0.0473, // Pakistan
  '880': 0.0433, // Bangladesh
  '63': 0.0517, // Philippines
  '44': 0.0592, // United Kingdom
  '1': 0.025, // US / Canada
};

/**
 * The rate for a phone this table does not recognise, and for a phone that
 * is not parseable at all. Computed, not hardcoded, so it cannot drift out
 * of "the highest rate in the table" when a row is added or repriced.
 */
export const UNKNOWN_COUNTRY_RATE_USD = Math.max(
  ...Object.values(MARKETING_RATE_USD_BY_PREFIX),
);

/** Longest prefix in the table — bounds the match loop. */
const MAX_PREFIX_LENGTH = Math.max(
  ...Object.keys(MARKETING_RATE_USD_BY_PREFIX).map((p) => p.length),
);

/**
 * Estimated cost of one marketing message to `phone`.
 *
 * Never throws: a malformed, empty or non-numeric phone takes the highest
 * rate, because the alternative — throwing mid-send — would strand a
 * recipient in `sending` over a formatting problem.
 */
export function estimateMessageCostUsd(
  phone: string | null | undefined,
): number {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 0) return UNKNOWN_COUNTRY_RATE_USD;

  for (let length = MAX_PREFIX_LENGTH; length >= 1; length -= 1) {
    const rate = MARKETING_RATE_USD_BY_PREFIX[digits.slice(0, length)];
    if (rate !== undefined) return rate;
  }
  return UNKNOWN_COUNTRY_RATE_USD;
}

/**
 * Estimated cost of a whole campaign, when the individual phones are not in
 * hand (pre-flight at schedule time, where only a COUNT is known).
 *
 * Uses the unknown-country rate per recipient: the same over-estimate rule,
 * for the same reason. A merchant is told a number that cannot be beaten by
 * the actual send.
 */
export function estimateCampaignCostUsd(recipientCount: number): number {
  return round4(recipientCount * UNKNOWN_COUNTRY_RATE_USD);
}

/** Sums a known set of recipient phones. Used once the snapshot exists. */
export function estimateCostForPhonesUsd(phones: readonly string[]): number {
  return round4(
    phones.reduce((total, phone) => total + estimateMessageCostUsd(phone), 0),
  );
}

/** `spent_usd` is numeric(10,4); rounding here keeps JS float drift out of the money column. */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
