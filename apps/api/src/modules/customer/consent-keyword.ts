// Does this inbound message ask us to stop, or to start again?
//
// A pure function, deliberately, for the same reason customerServiceWindow is
// one: it encodes a rule with real consequences and it must be exhaustively
// testable without a database, a BSP, or a running app.
//
// The matching is intentionally STRICT — the whole message must be the keyword,
// give or take surrounding whitespace and punctuation. Substring matching is
// the obvious first instinct and it is wrong: "please don't stop sending me
// updates" and "I stopped receiving these" both contain "stop", and silently
// unsubscribing someone who asked for the opposite is a worse failure than
// missing an unusual phrasing. A person who means it will send the word on its
// own, which is what every platform tells them to do.
//
// Case and diacritics are folded; a customer typing "Stop" or "STOP." is
// unambiguous.

/** Words that mean "stop messaging me". Meta's documented set, which customers are already trained on. */
const OPT_OUT_WORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'opt out',
]);

/** Words that mean "you may message me again". */
const OPT_IN_WORDS = new Set([
  'start',
  'unstop',
  'subscribe',
  'optin',
  'opt in',
]);

export type ConsentKeyword = 'opt_out' | 'opt_in' | null;

/**
 * Trims surrounding whitespace and punctuation, collapses inner whitespace so
 * "opt   out" still matches, then folds case. Shared with
 * `marketing-consent-keyword.ts` (F19) so both keyword sets agree on what
 * "the whole message, more or less" means.
 */
export function normalizeConsentText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Returns the consent intent of a message, or null when it carries none —
 * which is the overwhelmingly common case and must stay cheap.
 */
export function parseConsentKeyword(
  text: string | null | undefined,
): ConsentKeyword {
  const normalized = normalizeConsentText(text);

  if (normalized.length === 0) return null;
  if (OPT_OUT_WORDS.has(normalized)) return 'opt_out';
  if (OPT_IN_WORDS.has(normalized)) return 'opt_in';
  return null;
}
