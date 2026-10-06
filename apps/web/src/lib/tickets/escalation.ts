import { type EscalationReason } from "@repo/errors";
import {
  ESCALATION_TRIGGERS,
  type OptionalEscalationTrigger,
} from "@/lib/api/agents";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locale";
import { ordersEn } from "@/lib/i18n/dictionaries/fragments/orders.en";
import { ordersAr } from "@/lib/i18n/dictionaries/fragments/orders.ar";

/**
 * Human labels for every escalation reason. Typed as a total record over the
 * shared enum in @repo/errors, so if the backend adds a reason, this fails to
 * compile until it's mapped — the exact drift bug the old console shipped
 * ("wa window closed" rendered as raw enum text). Kept separate from the
 * general i18n Dictionary (rather than folded in) so this exhaustiveness
 * check stays enforced per-locale, not just for English.
 */
export const ESCALATION_LABELS: Record<EscalationReason, string> = {
  CONFIDENCE_BELOW_THRESHOLD: "Low confidence",
  FORBIDDEN_TOPIC: "Forbidden topic",
  EXPLICIT_USER_REQUEST: "Customer asked for a human",
  TOOL_FAILURE: "Tool failure",
  TOOL_SCOPE_VIOLATION: "Tool scope violation",
  DELIVERY_FAILURE: "Delivery failed",
  JOB_FAILURE: "Pipeline error",
  UNSUPPORTED_MEDIA: "Unsupported media",
  KB_NOT_INDEXED: "Not in knowledge base",
  KB_CONFLICT: "Conflicting sources",
  LLM_ERROR: "Model error",
  WA_WINDOW_CLOSED: "24h window closed",
  USAGE_CAP_EXCEEDED: "Usage cap reached",
  CUSTOMER_DISTRESS: "Customer distress",
  // F25 added this reason. Its copy lives in the `orders` fragment rather than
  // beside the others because the `tickets` namespace sits in en.ts/ar.ts,
  // which the orders lane does not own — see orders.en.ts for the note.
  CUSTOMER_COMPLAINT: ordersEn.escalationReason.customerComplaint,
  OPTED_OUT_CUSTOMER: "Customer opted out",
  BILLING_BLOCKED: "Subscription inactive",
};

const ESCALATION_LABELS_AR: Record<EscalationReason, string> = {
  CONFIDENCE_BELOW_THRESHOLD: "ثقة منخفضة",
  FORBIDDEN_TOPIC: "موضوع محظور",
  EXPLICIT_USER_REQUEST: "طلب العميل التحدث مع موظف",
  TOOL_FAILURE: "فشل في الأداة",
  TOOL_SCOPE_VIOLATION: "تجاوز نطاق الأداة",
  DELIVERY_FAILURE: "فشل التسليم",
  JOB_FAILURE: "خطأ في المعالجة",
  UNSUPPORTED_MEDIA: "وسائط غير مدعومة",
  KB_NOT_INDEXED: "غير موجود في قاعدة المعرفة",
  KB_CONFLICT: "مصادر متعارضة",
  LLM_ERROR: "خطأ في النموذج",
  WA_WINDOW_CLOSED: "انتهت نافذة الـ24 ساعة",
  USAGE_CAP_EXCEEDED: "تم بلوغ حد الاستخدام",
  CUSTOMER_DISTRESS: "ضيق العميل",
  CUSTOMER_COMPLAINT: ordersAr.escalationReason.customerComplaint,
  OPTED_OUT_CUSTOMER: "العميل رفض المتابعة",
  BILLING_BLOCKED: "الاشتراك غير نشط",
};

/**
 * The agent's optional escalation triggers (Settings → Agent → "Also escalate
 * on"). A trigger that fires is recorded with its own lowercase key as the
 * escalation reason, so analytics breakdowns receive these alongside the
 * D13 enum values above. Same exhaustiveness rule: total per locale.
 */
const TRIGGER_LABELS: Record<Locale, Record<OptionalEscalationTrigger, string>> = {
  en: {
    negative_sentiment: "Negative sentiment",
    repeat_question: "Repeated question",
    refund_request: "Refund request",
    order_change: "Order change",
    complaint: "Complaint",
  },
  ar: {
    negative_sentiment: "مشاعر سلبية",
    repeat_question: "سؤال متكرر",
    refund_request: "طلب استرداد",
    order_change: "تغيير الطلب",
    complaint: "شكوى",
  },
};

const LABELS_BY_LOCALE: Record<Locale, Record<EscalationReason, string>> = {
  en: ESCALATION_LABELS,
  ar: ESCALATION_LABELS_AR,
};

/**
 * Escalations that are not a confidence judgement (the API's list, HANDOFF
 * "QA 2026-10-05 #4"): a handoff rule, the customer's own request or state,
 * or an error that forced the handoff. The confidence score and the "no
 * knowledge-base sources" note say nothing about them, so the playground
 * hides both. CONFIDENCE_BELOW_THRESHOLD and KB_NOT_INDEXED stay out: a
 * prompt-injection refusal comes back under those, indistinguishable from a
 * genuine low-confidence answer, whose score is the finding.
 */
const DETERMINISTIC_REASONS: ReadonlySet<EscalationReason> = new Set([
  "EXPLICIT_USER_REQUEST",
  "FORBIDDEN_TOPIC",
  "TOOL_SCOPE_VIOLATION",
  "CUSTOMER_DISTRESS",
  "CUSTOMER_COMPLAINT",
  "OPTED_OUT_CUSTOMER",
  "BILLING_BLOCKED",
  "USAGE_CAP_EXCEEDED",
  "UNSUPPORTED_MEDIA",
  "KB_CONFLICT",
  "DELIVERY_FAILURE",
  "JOB_FAILURE",
  "LLM_ERROR",
  "WA_WINDOW_CLOSED",
  "TOOL_FAILURE",
]);

function isEscalationReason(value: string): value is EscalationReason {
  // Keyed off the exhaustive label record rather than the runtime enum, so
  // the console keeps importing only types from @repo/errors.
  return Object.hasOwn(ESCALATION_LABELS, value);
}

function isTrigger(value: string): value is OptionalEscalationTrigger {
  return (ESCALATION_TRIGGERS as readonly string[]).includes(value);
}

/** `SOME_new_reason` → "Some new reason": readable when the API ships a reason before the console maps it. */
export function humaniseReasonKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function escalationTriggerLabel(
  trigger: OptionalEscalationTrigger,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return TRIGGER_LABELS[locale][trigger];
}

/**
 * Label for any reason string the API can send: a D13 enum value, an agent
 * escalation trigger key, or (fallback) an unknown key, humanised.
 */
export function escalationLabel(reason: string, locale: Locale = DEFAULT_LOCALE): string {
  if (isEscalationReason(reason)) return LABELS_BY_LOCALE[locale][reason];
  if (isTrigger(reason)) return TRIGGER_LABELS[locale][reason];
  return humaniseReasonKey(reason);
}

export function isDeterministicEscalation(reason: string | null): boolean {
  return reason !== null && isEscalationReason(reason) && DETERMINISTIC_REASONS.has(reason);
}
