import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationParams,
  type NotificationRecord,
  type NotificationSeverity,
} from "@/lib/api/notifications";
import {
  COURIER_BRAND,
  COURIERS,
  SHIPMENT_STATUSES,
  type Courier,
  type ShipmentStatus,
} from "@/lib/api/delivery";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { Locale } from "@/lib/i18n/locale";
import { formatDuration } from "@/lib/i18n/relative-time";
import {
  type TemplateVariant,
  fillFirst,
  formatPlain,
  isolate,
} from "@/lib/i18n/template";
import { shipmentStatusLabel } from "@/components/delivery/format";
import { formatMoney } from "@/components/orders/format";

/**
 * Notification wording per kind, in both console languages, written from the
 * `params` the API records beside its English title/body (see the API's
 * notifications/notification-content.ts, one builder per kind).
 *
 * A template is used only when every `{placeholder}` in it has a value in
 * `params` (and its `when` matches); otherwise the next variant is tried, and
 * after the last one the API's English title and body are shown — never a
 * half-filled template. Typed total per locale, as with escalation labels, so a new kind
 * fails to compile until it is mapped here (an empty list means "English only
 * for now").
 */
type KindCopy = { title: readonly TemplateVariant[]; body: readonly TemplateVariant[] };

const failedToStart = (p: NotificationParams) => p.pauseStatus === "failed";
const pausedNotFailed = (p: NotificationParams) =>
  typeof p.pauseStatus === "string" && p.pauseStatus !== "failed";
const credentialsRejected = (p: NotificationParams) => p.cause === "credentials_rejected";
const unreachable = (p: NotificationParams) => p.cause === "unreachable";

const COPY: Record<Locale, Record<NotificationKind, KindCopy>> = {
  en: {
    ticket_stuck: {
      title: ["A ticket has gone unanswered for {minutes}"],
      body: [
        "This conversation was handed to a human {minutes} ago and nobody has picked it up. Your alert threshold is {thresholdMinutes}.",
      ],
    },
    latency_budget_exceeded: {
      title: ["Your agent is replying more slowly than usual"],
      body: [
        "Over the last {windowMinutes}, 95% of replies took under {p95Ms} against a {budgetMs} target ({sampleSize} replies).",
      ],
    },
    tool_scope_violations: {
      title: ["Your agent tried to use tools it is not allowed to use"],
      body: [
        "{violationCount} blocked tool calls in the last {windowMinutes}, past the threshold of {threshold}. The calls were blocked; this usually means a tool is configured for the agent but not enabled for your workspace.",
      ],
    },
    trial_ending: {
      title: ["Your Clarly trial ends in {daysLeft}"],
      body: [
        "Your trial ends in {daysLeft}. Add a payment method before then so your AI agent keeps replying to customers without interruption.",
      ],
    },
    trial_expired: {
      title: ["Your Clarly trial has ended"],
      body: [
        "Your trial has ended and your AI agent has stopped replying to customers. Add a payment method to pick up right where you left off — nothing about your setup is lost.",
      ],
    },
    payment_failed: {
      title: ["Your Clarly subscription payment failed"],
      body: [
        "Your latest payment did not go through. Your AI agent has been paused until you update your payment method. Update your card to restore service — your setup and conversation history are preserved.",
      ],
    },
    campaign_paused: {
      title: [
        { text: "Campaign “{campaignName}” could not start", when: failedToStart },
        { text: "Campaign “{campaignName}” paused", when: pausedNotFailed },
      ],
      body: [
        "{reason} Recipients still waiting: {remaining}. They stay queued until you resume or cancel the campaign.",
      ],
    },
    order_pending_approval: {
      title: ["Order {orderRef} is waiting for approval"],
      body: [
        "{customer} ordered {total} (items: {count}). Approve or reject it before the approval window closes.",
      ],
    },
    order_store_push_failed: {
      title: ["Order {orderRef} could not be sent to your store"],
      body: [
        "The order is confirmed in Clarly and the customer has been told. It has not reached your store: {error}. Retry it from the order, or enter it in your store by hand.",
      ],
    },
    order_auto_mode_review: { title: [], body: [] },
    courier_connection_failing: {
      title: [
        { text: "{courier} rejected your credentials", when: credentialsRejected },
        { text: "{courier} tracking has been failing", when: unreachable },
      ],
      body: [
        {
          text: "Delivery tracking for {courier} is switched off until the credentials are re-entered. Customers asking where their order is will get stale information until then.",
          when: credentialsRejected,
        },
        {
          text: "We have not been able to reach {courier} for {attempts} attempts in a row. Delivery statuses shown to customers may be out of date.",
          when: unreachable,
        },
      ],
    },
    shipment_template_unusable: {
      title: ["A shipment update could not be sent"],
      body: ["Customers are not being told when a parcel reaches “{status}”: {detail}"],
    },
    booking_requested: {
      title: ["Booking {bookingRef} is waiting for confirmation"],
      body: ["{service} on {when} for {customer}. Confirm or cancel it in Bookings, and let the customer know."],
    },
    calendar_needs_reconnect: {
      title: ["Reconnect your Google Calendar"],
      body: ["Google stopped accepting the connection for {account}. New bookings are recorded as requests until you reconnect it in Settings → Bookings."],
    },
  },
  ar: {
    ticket_stuck: {
      title: ["تذكرة بلا رد منذ {minutes}"],
      body: [
        "حُوّلت هذه المحادثة إلى موظف قبل {minutes} ولم يستلمها أحد بعد. حد التنبيه لديك {thresholdMinutes}.",
      ],
    },
    latency_budget_exceeded: {
      title: ["وكيلك يرد أبطأ من المعتاد"],
      body: [
        "خلال آخر {windowMinutes}، استغرق 95% من الردود أقل من {p95Ms} مقابل هدف قدره {budgetMs} (عدد الردود: {sampleSize}).",
      ],
    },
    tool_scope_violations: {
      title: ["حاول وكيلك استخدام أدوات غير مسموح له بها"],
      body: [
        "حُظرت محاولات لاستخدام أدوات خلال آخر {windowMinutes} (عددها: {violationCount}، والحد: {threshold}). لم تُنفَّذ هذه المحاولات، ويعني ذلك عادةً أن أداةً مُعدّة للوكيل لكنها غير مفعّلة لمساحة عملك.",
      ],
    },
    trial_ending: {
      title: ["تنتهي فترتك التجريبية في كلارلي خلال {daysLeft}"],
      body: [
        "تنتهي فترتك التجريبية خلال {daysLeft}. أضف وسيلة دفع قبل ذلك ليواصل وكيلك الرد على العملاء دون انقطاع.",
      ],
    },
    trial_expired: {
      title: ["انتهت فترتك التجريبية في كلارلي"],
      body: [
        "انتهت فترتك التجريبية وتوقف وكيلك عن الرد على العملاء. أضف وسيلة دفع لتكمل من حيث توقفت، فلن يضيع شيء من إعداداتك.",
      ],
    },
    payment_failed: {
      title: ["تعذّر تحصيل دفعة اشتراكك في كلارلي"],
      body: [
        "لم تنجح آخر عملية دفع، وأُوقف وكيلك مؤقتًا حتى تحدّث وسيلة الدفع. حدّث بطاقتك لاستعادة الخدمة، فإعداداتك وسجل محادثاتك محفوظة.",
      ],
    },
    campaign_paused: {
      title: [
        { text: "تعذّر بدء الحملة «{campaignName}»", when: failedToStart },
        { text: "توقفت الحملة «{campaignName}» مؤقتًا", when: pausedNotFailed },
      ],
      body: [
        "{reason} المستلمون الذين لم تصلهم الرسالة بعد: {remaining}، وسيبقون في قائمة الانتظار حتى تستأنف الحملة أو تلغيها.",
      ],
    },
    order_pending_approval: {
      title: ["الطلب {orderRef} بانتظار موافقتك"],
      body: [
        "طلب {customer} بقيمة {total} (عدد المنتجات: {count}). وافق عليه أو ارفضه قبل انتهاء مهلة الموافقة.",
      ],
    },
    order_store_push_failed: {
      title: ["تعذّر إرسال الطلب {orderRef} إلى متجرك"],
      body: [
        "الطلب مؤكد في كلارلي وأُبلغ العميل به، لكنه لم يصل إلى متجرك: {error}. أعد المحاولة من صفحة الطلب، أو أدخله في متجرك يدويًا.",
      ],
    },
    order_auto_mode_review: { title: [], body: [] },
    courier_connection_failing: {
      title: [
        { text: "رفضت {courier} بيانات الدخول الخاصة بك", when: credentialsRejected },
        { text: "يتعثر تتبّع الشحنات عبر {courier}", when: unreachable },
      ],
      body: [
        {
          text: "تتبّع الشحنات عبر {courier} متوقف حتى تُدخل بيانات الدخول من جديد، وإلى ذلك الحين سيحصل العملاء الذين يسألون عن طلباتهم على معلومات قديمة.",
          when: credentialsRejected,
        },
        {
          text: "تعذّر الوصول إلى {courier} (عدد المحاولات المتتالية: {attempts}). قد تكون حالات التوصيل المعروضة للعملاء قديمة.",
          when: unreachable,
        },
      ],
    },
    shipment_template_unusable: {
      title: ["تعذّر إرسال تحديث شحنة"],
      body: ["لا يُبلَّغ العملاء عند وصول الشحنة إلى حالة «{status}»: {detail}"],
    },
    booking_requested: {
      title: ["الحجز {bookingRef} بانتظار التأكيد"],
      body: ["{service} في {when} للعميل {customer}. أكّده أو ألغِه من الحجوزات، وأبلغ العميل."],
    },
    calendar_needs_reconnect: {
      title: ["أعد ربط تقويم Google"],
      body: ["توقف Google عن قبول الربط للحساب {account}. تُسجّل الحجوزات الجديدة كطلبات حتى تعيد الربط من الإعدادات ← الحجوزات."],
    },
  },
};

/** Severity a kind is recorded with, for a row whose own severity is missing or unrecognised. */
export const DEFAULT_SEVERITY: Record<NotificationKind, NotificationSeverity> = {
  ticket_stuck: "critical",
  latency_budget_exceeded: "warning",
  tool_scope_violations: "warning",
  trial_ending: "warning",
  trial_expired: "warning",
  payment_failed: "critical",
  campaign_paused: "warning",
  order_pending_approval: "warning",
  order_store_push_failed: "critical",
  order_auto_mode_review: "warning",
  courier_connection_failing: "warning",
  shipment_template_unusable: "warning",
  booking_requested: "warning",
  calendar_needs_reconnect: "critical",
};

export function isKnownKind(kind: string): kind is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

export function notificationSeverity(n: NotificationRecord): NotificationSeverity {
  if (n.severity === "critical" || n.severity === "warning") return n.severity;
  return isKnownKind(n.kind) ? DEFAULT_SEVERITY[n.kind] : "warning";
}

const DURATION_PARAMS: Readonly<Record<string, "minute" | "day">> = {
  minutes: "minute",
  thresholdMinutes: "minute",
  windowMinutes: "minute",
  daysLeft: "day",
};

const MILLISECOND_PARAMS: ReadonlySet<string> = new Set(["p95Ms", "budgetMs"]);

function isCourier(value: string): value is Courier {
  return (COURIERS as readonly string[]).includes(value);
}

function isShipmentStatus(value: string): value is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

function formatParam(
  name: string,
  value: string | number,
  params: NotificationParams,
  t: Dictionary,
  locale: Locale,
): string {
  if (typeof value === "number") {
    const unit = DURATION_PARAMS[name];
    if (unit) return formatDuration(value, unit, locale);
    if (MILLISECOND_PARAMS.has(name)) {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "millisecond",
        unitDisplay: "short",
      }).format(value);
    }
  }
  if (name === "total" && typeof params.currency === "string") {
    return isolate(formatMoney(String(value), params.currency, locale));
  }
  if (typeof value === "string") {
    if (name === "courier" && isCourier(value)) return isolate(COURIER_BRAND[value]);
    if (name === "status" && isShipmentStatus(value)) return shipmentStatusLabel(t, value);
  }
  return formatPlain(value, locale);
}

/**
 * Title and body in the reader's language, or both as the API wrote them.
 * All or nothing: rows recorded before params existed arrive with `{}`, and a
 * kind with a fixed title but a parameterised body would otherwise pair an
 * Arabic title with an English body.
 */
export function localiseNotification(
  n: Pick<NotificationRecord, "kind" | "title" | "body" | "params">,
  t: Dictionary,
  locale: Locale,
): { title: string; body: string } {
  const english = { title: n.title, body: n.body };
  if (!isKnownKind(n.kind)) return english;
  const copy = COPY[locale][n.kind];
  const params = n.params ?? {};
  const format = (name: string, value: string | number) =>
    formatParam(name, value, params, t, locale);
  const title = fillFirst(copy.title, params, format);
  const body = fillFirst(copy.body, params, format);
  return title !== null && body !== null ? { title, body } : english;
}

const KIND_HREF: Partial<Record<NotificationKind, string>> = {
  trial_ending: "/settings/billing",
  trial_expired: "/settings/billing",
  payment_failed: "/settings/billing",
  courier_connection_failing: "/settings/delivery",
  shipment_template_unusable: "/settings/delivery",
  booking_requested: "/bookings",
  calendar_needs_reconnect: "/settings/bookings",
};

/** Where clicking a notification goes: the thing it is about, else the page that fixes it. */
export function notificationHref(n: NotificationRecord): string | null {
  if (n.entityId) {
    if (n.entityType === "ticket") return `/tickets?ticket=${n.entityId}`;
    if (n.entityType === "order") return `/orders/${n.entityId}`;
    if (n.entityType === "campaign") return `/campaigns/${n.entityId}`;
  }
  return isKnownKind(n.kind) ? (KIND_HREF[n.kind] ?? null) : null;
}
