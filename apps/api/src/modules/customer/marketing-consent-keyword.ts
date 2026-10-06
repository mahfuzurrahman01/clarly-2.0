// F19 (Open Question 2, resolved 2026-09-21): the marketing-specific
// opt-out keyword, distinct from — and checked BEFORE — the global "STOP"
// handler in `consent-keyword.ts`.
//
// "unsubscribe" moves here rather than staying in the global `OPT_OUT_WORDS`
// set: `WebhookIngestService` checks this function first and `continue`s on
// a match, so an inbound "unsubscribe" is now marketing-only, never also
// evaluated by `parseConsentKeyword()`. `consent-keyword.ts`'s own unit tests
// are untouched (that module still parses "unsubscribe" as a global opt-out
// in isolation) — the split is a call-order decision in the ingest service,
// not a change to what each function recognises on its own.
import { normalizeConsentText } from './consent-keyword';

const MARKETING_OPT_OUT_PHRASES = new Set(['stop marketing', 'unsubscribe']);

/** True when the whole message (case/whitespace/punctuation folded) is a marketing-only opt-out keyword. */
export function isMarketingOptOutKeyword(
  text: string | null | undefined,
): boolean {
  const normalized = normalizeConsentText(text);
  return normalized.length > 0 && MARKETING_OPT_OUT_PHRASES.has(normalized);
}
