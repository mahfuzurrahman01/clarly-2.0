// A6/D12: "PII redact before logging." For logs/telemetry only (A8's
// agent_runs, later slice) — NEVER applied to the actual customer-facing
// reply, which must contain real details (order numbers, etc.) to be
// useful. Regex-based, not a full PII-detection model — covers the common,
// high-confidence patterns (email, phone, credit-card-shaped digit runs);
// documented as a floor, not a guarantee, same honesty as the countTokens()
// approximation in Slice 1.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Matches common phone formats: optional +country code, then groups of
// digits separated by spaces/dashes/dots/parens, 7+ digits total.
const PHONE_PATTERN =
  /(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}(?:[-.\s]?\d{2,4})?/g;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

export function redactPii(text: string): string {
  return text
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(CREDIT_CARD_PATTERN, '[REDACTED_CARD]')
    .replace(PHONE_PATTERN, (match) =>
      isLikelyPhoneNumber(match) ? '[REDACTED_PHONE]' : match,
    );
}

function isLikelyPhoneNumber(candidate: string): boolean {
  const digitCount = candidate.replace(/\D/g, '').length;
  return digitCount >= 7;
}
