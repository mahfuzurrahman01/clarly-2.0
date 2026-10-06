// Deterministic safety-escalation net (cycle 3, 2026-09-30).
//
// An allergy or a health risk is the one place a wrong answer can hurt a
// person, so "the model usually escalates" is not good enough. Measured on
// catering-quotes#7 ("my nephew has a severe peanut allergy. Is the kacchi
// biryani safe for him?"): the model refused correctly in words in every run
// but left `escalate: false` in 2 of 5, so the customer got a well-worded
// answer and no handoff. L0 asks for the handoff and the knowledge base says
// staff are not authorised to confirm it; this is the deterministic
// counterpart, in the same division of labour as customer-grievance.ts.
//
// SCOPE. Three shapes, each written for English, Arabic script (Gulf, Levantine
// and Egyptian terms) and Arabizi, because the risk does not depend on the
// dialect the customer writes in:
//   1. an allergy or intolerance (the customer, or someone they name, has one),
//   2. a stated medical condition where food or a product's safety is the point
//      (diabetes, pregnancy, asthma) and a medical emergency (chest pain,
//      cannot breathe, overdose, self-harm),
//   3. an incident that already hurt someone or is dangerous now (poisoning,
//      choking, electric shock, fire, an explosion).
//
// PRECISION. Bare food or product words ("nuts", "gluten free", "sugar",
// "overheating") are NOT matched: a customer asking whether a dish contains
// nuts, or a charger's rated temperature, is asking a knowledge-base question.
// The mention of an ALLERGY, a condition or an incident is what moves the
// answer from information to a safety judgement. Bare "سكري" is not matched
// either: it is also a very common date variety in Gulf catalogues.
// Verified against every question in `eval/corpora/*`: the only matches are
// catering-quotes#7 and #8 (allergies) and clinic-services#10 (chest pain),
// all of which expect an escalation.
//
// Like the other nets it decides WHETHER to escalate. The reason is set by the
// caller, once, at its call site.
import { containsArabicScript, normaliseArabic } from './arabic-normalisation';

const AR = '(?<![؀-ۿ])'; // start of an Arabic word

/** 1. Allergy or intolerance. */
const ALLERGY = [
  /\ballerg(?:y|ies|ic|en|ens)\b/i,
  /\banaphyla\w*/i,
  /\bepi-?pens?\b/i,
  /\b(?:celiac|coeliac)\b/i,
  /\b(?:lactose|gluten|nut|peanut|dairy|egg|shellfish|soy|fructose)[ -]intoleran\w*/i,
  /\bintoleran\w*\s+to\b/i,
  // Arabic: حساسية (allergy) in every spelling, the Gulf/Levantine verb
  // (يتحسس / متحسس / عنده تحسس), anaphylaxis and coeliac disease.
  new RegExp(`${AR}(?:ال)?حساسي[ةه]`),
  new RegExp(`${AR}(?:[يتان]?تحسس|متحسس)\\S*`),
  /صدم[ةه]\s*تحسسي[ةه]/,
  /سيلياك/,
  // Arabizi: 7asasiya / hasasiyeh / 7sasyeh, and "alergy" typed by ear.
  /\b[7h]a?s{1,2}a?s{1,2}(?:[ie]?y|[ie])[aeiy]*h?\b/i,
  /\ba+l+e+r+g\w*/i,
];

/** 2. A stated condition where safety is the point, or a medical emergency. */
const HEALTH_CONDITION = [
  /\b(?:i(?:'m| am)|my (?:wife|husband|mother|father|son|daughter|nephew|niece|child|baby|friend)(?: is|'s)|he(?:'s| is)|she(?:'s| is))\s+(?:pregnant|diabetic|asthmatic|epileptic)\b/i,
  /\b(?:diabetes|diabetic|asthma|epilep\w*)\b/i,
  /\b(?:heart|kidney|liver)\s+(?:condition|disease|problem)s?\b/i,
  /\b(?:pregnan\w*|breastfeeding|nursing mother)\b/i,
  /\b(?:chest\s+(?:pain|hurts?|is hurting)|(?:can'?t|cannot|unable to|difficulty|trouble)\s+breath\w*|short(?:ness)?\s+of\s+breath|unconscious|passed out|overdos\w*|suicid\w*|(?:had|having) (?:a )?(?:seizure|stroke|heart attack))\b/i,
  new RegExp(`${AR}ربو(?![؀-ۿ])`),
  /(?:مرض\s*(?:ال)?سكر(?:ي)?|مريض(?:ه|ة)?\s*(?:ب)?(?:ال)?سكر(?:ي)?|مصاب(?:ه|ة)?\s*ب(?:ال)?سكر(?:ي)?|(?:عنده|عندها|عندي|عندو)\s+(?:ال)?سكري)/,
  /(?:انا|زوجتي|مرتي|حرمتي|اختي|امي|بنتي)\s+حامل/,
  /(?:الم|وجع)\s*(?:في|ب)?\s*(?:ال)?صدر/,
  /صدري\s*(?:يوجعني|يؤلمني|يوجعني|ياكلني|وجعني)/,
  /(?:ما\s*اقدر|مو\s*قادر|مش\s*قادر)\s*(?:ا)?تنفس/,
  /(?:ضيق|صعوبه|صعوبة)\s*(?:في|ب)?\s*(?:ال)?تنفس/,
  /(?:فقد(?:ت)?\s*(?:ال)?وعي|اغمي\s*علي(?:ه|ها)?)/,
  /(?:جرع[ةه]\s*زائد[ةه]|نوب[ةه]\s*قلبي[ةه]|جلط[ةه]|انتحار|انتحر)/,
  /\b(?:sadri|9adri)\s+(?:yuja3ni|yiwja3ni|by?ouja3ni|yo?ja3ni)\b/i,
];

/** 3. An incident that hurt someone or is dangerous now. */
const INCIDENT = [
  /\b(?:food\s+poisoning|poisoned|choking|choked|electrocut\w*|electric(?:al)?\s+shock)\b/i,
  /\b(?:caught|catching)\s+fire\b/i,
  /\bset\s+(?:on\s+)?fire\b/i,
  /\b(?:burst\s+into\s+flames|exploded|explosion)\b/i,
  /\b(?:burn(?:ed|t)|scalded|shocked)\s+(?:me|my|him|her|his|the child|my (?:son|daughter|child|baby))\b/i,
  /\b(?:got|fell|became|feeling)\s+(?:very\s+)?(?:sick|ill)\s+(?:after|from)\b/i,
  /(?:تسمم\w*|اختنق\w*|اختناق|صعقه?\s*كهربائي[ةه]|صعقني|صعقته)/,
  /(?:ولعت|اشتعلت|شبت|شب)\s*(?:فيه|فيها|به|بها)?\s*(?:ال)?(?:نار|حريق)/,
  /(?:انفجر\w*|اشتعل\w*)/,
  /\b(?:tasammum|tasamum|tasammam)\b/i,
];

const SAFETY_PATTERNS = [...ALLERGY, ...HEALTH_CONDITION, ...INCIDENT];

/**
 * True when the customer's own message mentions an allergy, a health condition
 * or emergency, or a safety incident. Pure and side-effect free; the caller
 * decides what to do with it and sets `escalation_reason` at its own call site.
 */
export function reportsSafetyRisk(message: string): boolean {
  const normalised = normaliseArabic(message);
  return SAFETY_PATTERNS.some((pattern) => pattern.test(normalised));
}

const ENGLISH_HANDOFF =
  "I can't confirm allergy or health safety in this chat, and I don't want you to rely on a guess. I'm connecting you with a member of our team who can help with this. If this is an emergency, please contact your local emergency services right away.";

const ARABIC_HANDOFF =
  'لا أستطيع تأكيد السلامة من ناحية الحساسية أو الحالة الصحية عبر هذه الدردشة، ولا أريدك أن تعتمد على تخمين. سأحوّلك الآن إلى أحد أفراد فريقنا ليساعدك. وإذا كانت حالة طارئة، يرجى الاتصال بخدمات الطوارئ فورًا.';

/**
 * The reply for a safety turn the model did NOT escalate itself. It replaces
 * the model's draft, which may be an assurance ("it is safe") that nobody
 * qualified to give it has checked. Carries no fact about the business, so it
 * cannot be wrong about one; Arabic script in the customer's message selects
 * the Arabic wording, everything else gets English.
 */
export function safetyHandoffAnswer(customerMessage: string): string {
  return containsArabicScript(customerMessage)
    ? ARABIC_HANDOFF
    : ENGLISH_HANDOFF;
}
