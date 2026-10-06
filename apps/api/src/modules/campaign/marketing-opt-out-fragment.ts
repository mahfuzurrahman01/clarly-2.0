// F19 (Open Question 2): "every campaign send appends one line with this
// instruction, sourced from a shared template fragment, not duplicated per
// campaign." A pure, dependency-free module on purpose — the sender is a
// later slice, but the fragment itself is not sender-specific: any place
// that renders a campaign body (a future preview, the eventual sender) must
// use this ONE copy, not restate the wording.
export const MARKETING_OPT_OUT_FRAGMENT =
  'Reply "STOP MARKETING" or "UNSUBSCRIBE" to stop receiving marketing messages from us.';

/** Appends the fragment to a rendered template body, exactly once. */
export function appendMarketingOptOutFragment(renderedBody: string): string {
  return `${renderedBody}\n\n${MARKETING_OPT_OUT_FRAGMENT}`;
}

/**
 * The keywords the inbound handler recognises (see
 * `customer/marketing-consent-keyword.ts`). A MARKETING template body must
 * tell the customer at least one of them, because a broadcast the recipient
 * cannot stop is exactly what gets a number's quality rating cut.
 */
const OPT_OUT_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /stop\s+marketing/i,
  /unsubscribe/i,
  /إلغاء\s*الاشتراك/,
];

/**
 * Whether an APPROVED template body already carries an opt-out instruction.
 *
 * Why this is a check and not an append: a WhatsApp template send transmits
 * the template NAME and its positional parameters — Meta renders the body
 * from what it approved. Text appended at send time would never reach the
 * customer, and storing it in the transcript would make the transcript lie
 * about what was said. So the instruction has to be IN the approved body,
 * and the campaign gate's job is to refuse a marketing broadcast whose
 * template does not have one.
 */
export function carriesMarketingOptOutInstruction(body: string): boolean {
  return OPT_OUT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(body));
}
