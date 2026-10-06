// Deterministic net for "the customer says it is late AND the shipment proves
// it" (cycle 3, 2026-09-30).
//
// commerce-complaint#6 ("طلبيتي رقم AWB-C-9004 متأخرة كثير عن الموعد المتوقع")
// missed its escalation in 3 of 3 runs: the agent called track_order, got a
// shipment still out_for_delivery 8 days past its estimated date, and answered
// with the status and a paragraph about peak seasons, confidence 1. L0 says a
// late order is a CUSTOMER_COMPLAINT; after a tool succeeded the model treats
// the answer as done. A stated complaint escalates even when a tool answered
// the question.
//
// Two conditions, both required, so a plain status question never escalates:
//   1. the customer's message says the order is late or has not arrived
//      (English, Arabic script and Arabizi), and
//   2. a track_order result of this turn shows a shipment that is undelivered
//      and either overdue (its estimated delivery date passed by at least a
//      day) or in a problem status (exception, failed attempt).
// The message alone is not enough (no evidence yet: the model asks for the
// tracking number and escalates on its own, as commerce-complaint#8 does), and
// the shipment alone is not enough ("where is my order?" on an overdue parcel
// is a status question).
import { z } from 'zod';
import { normaliseArabic } from './arabic-normalisation';

/** An estimated date is a calendar day; the parcel is overdue only once that whole day has passed. */
export const OVERDUE_AFTER_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(['delivered', 'returned', 'cancelled']);
const PROBLEM_STATUSES = new Set(['exception', 'failed_attempt']);

const ShipmentsResultSchema = z.object({
  shipments: z.array(
    z.object({
      status: z.string(),
      estimatedDeliveryAt: z.string().nullish(),
    }),
  ),
});

const REPORTS_LATE = [
  /\b(?:late|delayed?|overdue|behind schedule)\b/i,
  /\btaking\s+(?:forever|ages|so long|too long|a long time)\b/i,
  /\b(?:has\s?n[o']?t|has not|still not|not yet|never)\s+(?:arrived|come|shown up|been delivered|delivered|here)\b/i,
  /\bstill\s+(?:waiting|not here)\b/i,
  /\b(?:should|was supposed to|were supposed to|was meant to)\s+(?:have\s+)?(?:arrive|arrived|be here|come|been delivered)\b/i,
  // Arabic (folded): متأخرة / تأخرت / تأخير, "did not arrive", "should have arrived".
  /تاخر|تاخير/,
  /(?:ما|لم|لسه\s*ما|لسا\s*ما|لين\s*الحين\s*ما|ولين\s*الحين\s*ما)\s*(?:وصل|توصل|يوصل|وصلت|وصلني|جاني|جاتني)/,
  /(?:ماوصل|ماوصلت|مو\s*واصل|مش\s*واصل|لسه\s*مجاش|ما\s*جاء|لم\s*يصل)/,
  /(?:كان|كانت)\s*(?:لازم|المفروض|المتوقع)[\s\S]{0,20}(?:يوصل|توصل|وصل|وصلت)/,
  // Arabizi
  /\b(?:mit|mut|mota|mt|ta)[2']?a?kh+[ae]?r\w*\b/i,
  /\bma\s*w[ae]?sal(?:at|it)?\b/i,
];

/** True when the customer says the order is late or has not arrived. */
export function reportsLateDelivery(message: string): boolean {
  const normalised = normaliseArabic(message);
  return REPORTS_LATE.some((pattern) => pattern.test(normalised));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * True when a track_order result in `toolEvidence` shows an undelivered
 * shipment that is overdue against `nowMs` or in a problem status. Matched by
 * shape (a top-level `shipments` array), so a create_order result, a refusal or
 * a catalogue lookup never counts.
 */
export function shipmentShowsProblem(
  toolEvidence: string[],
  nowMs: number,
): boolean {
  return toolEvidence.some((evidence) => {
    const parsed = ShipmentsResultSchema.safeParse(parseJson(evidence));
    if (!parsed.success) return false;
    return parsed.data.shipments.some((shipment) => {
      if (TERMINAL_STATUSES.has(shipment.status)) return false;
      if (PROBLEM_STATUSES.has(shipment.status)) return true;
      const estimatedMs = shipment.estimatedDeliveryAt
        ? Date.parse(shipment.estimatedDeliveryAt)
        : Number.NaN;
      return (
        Number.isFinite(estimatedMs) && nowMs - estimatedMs >= OVERDUE_AFTER_MS
      );
    });
  });
}

/** The customer says it is late AND this turn's track_order result shows a late or problem shipment. */
export function isLateDeliveryComplaint(
  message: string,
  toolEvidence: string[],
  nowMs: number,
): boolean {
  return (
    reportsLateDelivery(message) && shipmentShowsProblem(toolEvidence, nowMs)
  );
}
