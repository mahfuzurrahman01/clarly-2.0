import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { MessageTemplateRecord } from "@/lib/api/templates";
import { fill } from "./format";

/**
 * D2's template gate, mirrored on the merchant's screen.
 *
 * The send path enforces this at four points; the console's job is to make
 * sure a merchant never composes a campaign that schedule would refuse. Four
 * of the five checks are reproducible here from the template record the
 * templates API already returns:
 *
 *  1. kind is `whatsapp_template` (a canned reply is not sendable outside
 *     the 24h window),
 *  2. `approvalStatus === 'approved'` — anything else quotes Meta's own
 *     `approvalDetail`,
 *  3. category is MARKETING or UTILITY — AUTHENTICATION in a broadcast is a
 *     policy violation against the tenant's own WABA,
 *  4. a MARKETING template's APPROVED BODY already carries an opt-out
 *     instruction. Meta renders the body it approved, so the line cannot be
 *     appended at send time; without it, schedule returns 409.
 *
 * The fifth (the template's WABA must match the sending number's) is not
 * enforced by the backend either — `message_templates` carries no `waba_id`
 * column yet — so it is not faked here.
 */

/** Patterns from the API's `marketing-opt-out-fragment.ts`. Kept identical so the two sides agree. */
const OPT_OUT_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /stop\s+marketing/i,
  /unsubscribe/i,
  /إلغاء\s*الاشتراك/,
];

export function carriesMarketingOptOut(body: string): boolean {
  return OPT_OUT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(body));
}

export type TemplateBlock =
  | { reason: "kind"; message: string }
  | { reason: "approval"; message: string }
  | { reason: "category"; message: string }
  | { reason: "marketing_opt_out"; message: string };

/** Null when the template is broadcastable; otherwise why it is not. */
export function templateBlock(
  template: MessageTemplateRecord,
  t: Dictionary,
): TemplateBlock | null {
  if (template.kind !== "whatsapp_template") {
    return { reason: "kind", message: t.campaigns.template.blockedCanned };
  }

  if (template.approvalStatus !== "approved") {
    return {
      reason: "approval",
      message: template.approvalDetail
        ? fill(t.campaigns.template.blockedApproval, {
            detail: template.approvalDetail,
          })
        : t.campaigns.template.blockedApprovalPlain,
    };
  }

  if (template.category !== "MARKETING" && template.category !== "UTILITY") {
    return {
      reason: "category",
      message: t.campaigns.template.blockedAuthentication,
    };
  }

  if (
    template.category === "MARKETING" &&
    !carriesMarketingOptOut(template.body)
  ) {
    return {
      reason: "marketing_opt_out",
      message: t.campaigns.template.marketingOptOutBody,
    };
  }

  return null;
}

/** Splits a template body into its literal text and `{{n}}` placeholders, for the preview. */
export function splitTemplateBody(
  body: string,
): { text: string; placeholder: number | null }[] {
  const parts: { text: string; placeholder: number | null }[] = [];
  const pattern = /\{\{(\d+)\}\}/g;
  let index = 0;
  let match = pattern.exec(body);
  while (match) {
    if (match.index > index) {
      parts.push({ text: body.slice(index, match.index), placeholder: null });
    }
    parts.push({ text: match[0], placeholder: Number(match[1]) });
    index = match.index + match[0].length;
    match = pattern.exec(body);
  }
  if (index < body.length) {
    parts.push({ text: body.slice(index), placeholder: null });
  }
  return parts;
}
