// ISSUE-001: pure helpers for the one-shot holding reply sent while a human
// owns a conversation. Kept out of RespondPathProcessor so the processor stays
// orchestration-only and this logic is testable without a harness.

const ARABIC_SCRIPT = /[؀-ۿ]/;

const HOLDING_REPLY_EN = 'A team member will reply shortly.';
const HOLDING_REPLY_AR = 'سيقوم أحد أعضاء الفريق بالرد عليك قريباً.';

// "human / person / agent / management / manager / representative / staff",
// preceded by a speak/talk/connect/get/need/want verb. Deliberately narrow:
// a false positive costs one extra holding reply, a false negative a silent
// customer, but the "no human replied yet" path covers the latter.
const EN_HUMAN_REQUEST =
  /\b(talk|speak|chat|connect|transfer|get|need|want|reach|contact)\b[^.?!]{0,30}\b(human|person|agent|representative|rep|manager|management|supervisor|staff|someone|owner)\b/i;
const AR_HUMAN_REQUEST =
  /(موظف|مدير|الإدارة|الادارة|إدارة|ادارة|مسؤول|شخص|إنسان|انسان|خدمة العملاء|ممثل)/;

/** True when the customer is explicitly asking for a person or management. */
export function asksForHumanContact(text: string): boolean {
  return EN_HUMAN_REQUEST.test(text) || AR_HUMAN_REQUEST.test(text);
}

/** The holding reply, in the script the customer wrote in. */
export function holdingReplyFor(customerText: string): string {
  return ARABIC_SCRIPT.test(customerText) ? HOLDING_REPLY_AR : HOLDING_REPLY_EN;
}
