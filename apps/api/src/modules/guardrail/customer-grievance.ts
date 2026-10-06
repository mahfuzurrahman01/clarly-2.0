// A5/A6/D12 (F27, 2026-09-22): the INPUT-side half of the distress net.
//
// `distress-acknowledgement.ts` catches the case where the model names the
// customer's anger in its own answer and then declines to hand off. That net is
// written in English second-person ("you are frustrated"), so it cannot fire on
// a turn the model answers in Arabic — and the F27 Gulf Arabic corpora showed it
// never does. Measured 2026-09-21 against DeepSeek over the four Gulf corpora
// (`gulf-arabic-{khaleeji,egyptian,levantine,arabizi}`), every dialect failed the
// same four complaint cases, in two shapes:
//
//   "من اسبوعين استنى ما وصل"   → escalate: true,  escalation_reason:
//                                  CONFIDENCE_BELOW_THRESHOLD   (right call,
//                                  wrong label — CUSTOMER_DISTRESS is invisible
//                                  in the escalation mix)
//   "وصلني مكسور هيدا غلط"      → escalate: false, generic return-policy text
//                                  (missed escalation outright)
//
// L0 already states the rule ("angry, threatening, distressed, or reports harm,
// loss or an urgent problem → CUSTOMER_DISTRESS"), so this is D12's deterministic
// counterpart to a prompt rule the model applies reliably in English and
// unreliably in Arabic — the same division of labour as the answer-side net.
//
// PRECISION is the whole design constraint, because a complaint is not
// automatically distress and several corpus cases prove it: "the item I got is
// defective, what are my options" (`tone-escalation#9`), "my headphones arrived
// broken and I opened them, can I return them" (`refund-policy#4`) and "my
// delivery seems to be running late, could you check?" (`tone-escalation#8`) are
// all calm questions that must resolve, not escalate. So this is NOT a
// damage/lateness detector. It matches only four GRIEVANCE shapes — a report of
// loss the customer is not asking a question about:
//
//   1. "this is wrong / this is not my order"     (wrong item asserted)
//   2. "give me my money back"                     (refund demanded, not asked about)
//   3. "I have been waiting <weeks> and it never arrived" (prolonged non-delivery)
//   4. "the colour is different from the photos"   (what arrived ≠ what was sold)
//
// Each shape is expressed for Arabic script, Arabizi and English, because the
// gap is lexical, not conceptual — an English customer writing any of these four
// is equally distressed, and the rule must not be dialect-specific policy.
// Verified against every question in `eval/corpora/*`: the only matches are the
// sixteen F27 complaint cases that expect CUSTOMER_DISTRESS.
//
// It is a NET, not a classifier: it cannot catch grievance phrased outside these
// four shapes, and L0's rule plus the answer-side net stay in place.

import { normaliseArabic } from './arabic-normalisation';

/** 1. The customer asserts what they received is wrong / not what they ordered. */
const WRONG_ITEM = [
  /(?:هذا|هذه|ذا|ده|دي|هيدا|هاد|هادا)\s*(?:مو|مش|مب)?\s*(?:غلط|خطا)/,
  /(?:مو|مش|مب)\s*(?:طلبي|طلبنا|طلبتي|اللي طلبت)/,
  /\bhadh?[ai]?\s+(?:ghal[at]t?|khata)\b/i,
  /\b(?:mu|mo|mish|mesh|mub)\s+(?:talab|tlab)(?:i|na)\b/i,
  /\bthis is (?:not what i ordered|the wrong |wrong\b)/i,
  /\bnot what i ordered\b/i,
];

/** 2. The customer demands their money back (as a demand, not a question about the refund policy). */
const MONEY_BACK = [
  /فلوس\S*\s*(?:\S+\s+){0,2}?(?:رجع|ترجع|يرجع|رجعو|ردو|رد|استرجاع)/,
  /(?:رجعو|ارجعو|ردو)\S*\s*(?:\S+\s+){0,2}?فلوس/,
  /\bflus\S*\s+(?:\S+\s+){0,2}?(?:rudd|rid|rajji3|raj3|tirja3|turja3|irja3|yirja3)/i,
  /\b(?:i want|give me|send me|return)\b[^.!?]{0,30}\bmy money back\b/i,
  /\brefund my money\b/i,
];

/** 3. The customer has been waiting and the order never arrived. */
const NEVER_ARRIVED_AFTER_WAITING = [
  /(?:استني|استنا|منتظر|انتظر|صار لي|من اسبوع|من اسبوعين|من شهر|من اتنين)[\s\S]{0,40}(?:ما وصل|ماوصل|مو واصل|مش واصل|لم يصل|لسه ما وصل)/,
  /(?:ما وصل|ماوصل|مو واصل|مش واصل|لم يصل)[\s\S]{0,40}(?:استني|استنا|منتظر|انتظر|من اسبوع|من اسبوعين|من شهر)/,
  /\b(?:astanna?|3am astanna?|muntadhir|min usbu3(?:ayn)?|min shahr)\b[\s\S]{0,40}\bma\s*w[ae]?sal\b/i,
  /\bma\s*w[ae]?sal\b[\s\S]{0,40}\b(?:astanna?|muntadhir|min usbu3(?:ayn)?|min shahr)\b/i,
  /\b(?:still|been)\s+waiting\b[\s\S]{0,60}\b(?:has\s?n[o']t|has not|never|still hasn)\b[\s\S]{0,20}\b(?:arrived|come|shown up|showed up)\b/i,
  /\bit'?s been\b[\s\S]{0,20}\b(?:weeks|months|a month)\b[\s\S]{0,40}\b(?:nothing|not|never)\b[\s\S]{0,20}\b(?:arrived|come|delivered)\b/i,
];

/** 4. What arrived does not match what was advertised. */
const NOT_AS_PICTURED = [
  /(?:مختلف|غير|مو نفس|مش نفس|ما يشبه)\s*(?:\S+\s+){0,2}?(?:الصور|الصوره|الصورة)/,
  /\b(?:ghayr|mukhtalif|mu nafs|mish nafs)\b[\s\S]{0,20}\bal-?suwar\b/i,
  /\b(?:colou?r|item|product|it)\s+(?:is\s+)?different\s+(?:from|than|to)\s+the\s+(?:photos?|pictures?|images?)\b/i,
];

const GRIEVANCE_PATTERNS = [
  ...WRONG_ITEM,
  ...MONEY_BACK,
  ...NEVER_ARRIVED_AFTER_WAITING,
  ...NOT_AS_PICTURED,
];

/**
 * True when the customer's own message reports a loss or a wrong outcome rather
 * than asking a question about one — L0's "reports harm, loss or an urgent
 * problem" limb, in Arabic, Arabizi and English. Pure and side-effect free; the
 * caller decides what to do with it and sets `escalation_reason` once, at its
 * own call site.
 */
export function reportsCustomerGrievance(message: string): boolean {
  const normalised = normaliseArabic(message);
  return GRIEVANCE_PATTERNS.some((pattern) => pattern.test(normalised));
}
