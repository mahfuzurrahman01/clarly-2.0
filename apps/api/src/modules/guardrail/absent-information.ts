// Deterministic detector for an answer that says the business's information
// does not cover the question (cycle 3, 2026-09-30).
//
// catering-quotes#13 ("do you also do photography and stage decoration") was
// answered "The provided information only covers catering services, menus, and
// pricing. It does not mention photography or stage decoration services." with
// confidence 1 and no escalation, in 5 of 5 runs. The model marked the turn
// `no_kb_needed` (a flag meant for greetings, thank-yous and refusals), which
// waives the zero-citation override, so nothing downstream could see that the
// answer is an admission that the knowledge base cannot answer, exactly the
// turn L0 sends to a human.
//
// `no_kb_needed` may only ever relax the zero-citation override for a turn that
// states no business fact. An answer that says the information is missing is
// about the business by definition, so the waiver does not apply to it.
//
// Measured against every uncited, non-escalated, tool-less turn of the cycle-3
// eval (greetings, thank-yous, refusals of other customers' data, the injected
// "ignore your rules" notice): the only turn this matches is #13.
import { normaliseArabic } from './arabic-normalisation';

const ABSENCE = [
  /\b(?:does|do|did)\s*(?:not|n['’]?t)\s+(?:mention|cover|include|specify|say|list|state|contain)\b/i,
  /\b(?:no|not\s+enough|insufficient)\s+(?:information|info|details?)\b/i,
  /\b(?:(?:i|we)\s+(?:do\s*not|don['’]?t)\s+have|(?:i|we)\s+(?:have\s+no|lack)|(?:is|are)\s+not\s+(?:available|provided|included)|not\s+(?:covered|mentioned|listed|specified))\b[^.!?\n]{0,40}\b(?:information|info|details?|records?|data|knowledge)\b/i,
  /\bonly\s+covers?\b/i,
  /\b(?:can(?:not|['’]?t)|unable\s+to|could\s+not|couldn['’]?t)\s+(?:find|confirm|verify)\s+(?:any\s+)?(?:information|details?)\b/i,
  // Arabic (folded): "no information", "not mentioned", "only covers".
  /(?:لا|ما)\s*(?:تتوفر|يتوفر|توجد|يوجد|عندي|لدي|عندنا|لدينا|املك)\s*(?:لدي|عندي|لدينا|عندنا)?\s*(?:اي\s*)?(?:معلومات|تفاصيل|بيانات)/,
  /(?:غير|ليس)\s*(?:مذكور|مذكوره|مذكورة|متوفر|متوفره|متوفرة|مدرج|مدرجه|مدرجة)/,
  /(?:لا|ما)\s*(?:يذكر|تذكر|يغطي|تغطي|يشمل|تشمل)/,
  /(?:تغطي|يغطي)\s*فقط/,
];

/** True when the answer says the information it works from does not cover what was asked. */
export function admitsMissingInformation(answer: string): boolean {
  const normalised = normaliseArabic(answer);
  return ABSENCE.some((pattern) => pattern.test(normalised));
}
