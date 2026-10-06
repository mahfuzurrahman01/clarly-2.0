import { COURIER_BRAND, COURIERS, type Courier } from "@/lib/api/delivery";
import type { AuditLogEntry } from "@/lib/api/audit-log";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { Locale } from "@/lib/i18n/locale";
import { formatDuration } from "@/lib/i18n/relative-time";
import {
  type TemplateParams,
  type TemplateVariant,
  fillFirst,
  formatPlain,
  isolate,
} from "@/lib/i18n/template";
import { formatDate, formatDateTime } from "@/components/delivery/format";
import { formatMoney, modeName } from "@/components/orders/format";

/**
 * Audit `detail` sentences per `detailKey`, in both console languages. The
 * keys and their params are the API's contract (audit/audit-detail-catalog.ts:
 * "never rename one"). Typed total per locale so a key added to the union
 * below must be written in both. A key the console doesn't know, or params
 * that don't fill the template, show the API's English `detail`.
 */
type AuditDetailKey =
  | "order.approved"
  | "order.rejected"
  | "order.cancelled"
  | "order.store_push_requeued"
  | "order_settings.updated"
  | "data_export.requested"
  | "data_export.downloaded"
  | "courier.connected"
  | "courier.saved_inactive"
  | "courier.deactivated"
  | "courier.webhook_secret_rotated"
  | "shipment.recorded"
  | "delivery_notifications.enabled"
  | "delivery_notifications.disabled"
  | "template_message.not_delivered"
  | "workspace.closed"
  | "workspace.reopened"
  | "workspace.profile_updated"
  | "widget.updated"
  | "widget.key_rotated"
  | "booking_settings.updated"
  | "booking_service.created"
  | "booking_service.updated"
  | "booking.created"
  | "booking.confirmed"
  | "booking.cancelled"
  | "booking.completed"
  | "booking.no_show"
  | "calendar.connected"
  | "calendar.disconnected"
  | "kb_document.deleted"
  | "segment.created"
  | "segment.updated"
  | "segment.deleted"
  | "campaign.created"
  | "campaign.edited"
  | "campaign.scheduled"
  | "campaign.scheduled_immediate"
  | "campaign.paused"
  | "campaign.resumed"
  | "campaign.canceled"
  | "team.role_changed"
  | "team.member_removed"
  | "customer.label_overridden"
  | "customer.label_cleared"
  | "consent.opted_out"
  | "consent.opted_in"
  | "marketing_consent.opted_out"
  | "marketing_consent.cleared";

/** The API sends 0 for a campaign whose recipient set is not snapshotted yet. */
const hasRecipients = (p: TemplateParams) => typeof p.recipientCount === "number" && p.recipientCount > 0;
const noRecipientsYet = (p: TemplateParams) => p.recipientCount === 0;

const COPY: Record<Locale, Record<AuditDetailKey, readonly TemplateVariant[]>> = {
  en: {
    "order.approved": ["Approved order {orderRef} ({total})"],
    "order.rejected": ["Rejected order {orderRef}: {reason}"],
    "order.cancelled": ["Cancelled order {orderRef}"],
    "order.store_push_requeued": ["Re-queued the store push for order {orderRef}"],
    "order_settings.updated": [
      "Set order mode to “{mode}” (cash on delivery {cod}, approval window {approvalWindowHours})",
    ],
    "data_export.requested": ["Requested a full data export ({exportId})"],
    "data_export.downloaded": ["Downloaded the data export bundle {exportId}"],
    "courier.connected": ["Connected the {courier} courier account {accountRef}"],
    "courier.saved_inactive": ["Saved the {courier} courier account {accountRef} as inactive"],
    "courier.deactivated": ["Deactivated courier connection {connectionId}"],
    "courier.webhook_secret_rotated": [
      "Rotated the webhook secret for courier connection {connectionId}",
    ],
    "shipment.recorded": ["Recorded a {courier} shipment ({trackingNumber}) for order {orderRef}"],
    "delivery_notifications.enabled": [
      "Turned delivery notifications on (mapped statuses: {mappedStatuses})",
    ],
    "delivery_notifications.disabled": [
      "Turned delivery notifications off (mapped statuses: {mappedStatuses})",
    ],
    "template_message.not_delivered": ["Template message was not delivered: {error}"],
    "workspace.closed": ["Closed the workspace; data scheduled for erasure after {purgeAfter}"],
    "workspace.reopened": ["Reopened the workspace before its scheduled erasure"],
    "workspace.profile_updated": ["Updated the workspace profile ({fields})"],
    "widget.updated": ["Updated the website chat widget ({enabled}, {origins} allowed website(s))"],
    "widget.key_rotated": ["Issued a new website chat widget key"],
    "booking_settings.updated": ["Updated booking settings (mode {mode}, time zone {timeZone})"],
    "booking_service.created": ["Added the bookable service “{serviceName}”"],
    "booking_service.updated": ["Edited the bookable service “{serviceName}”"],
    "booking.created": ["Added booking {bookingRef}: {service} on {when}"],
    "booking.confirmed": ["Confirmed booking {bookingRef}"],
    "booking.cancelled": ["Cancelled booking {bookingRef} {reason}"],
    "booking.completed": ["Marked booking {bookingRef} as done"],
    "booking.no_show": ["Marked booking {bookingRef} as a no-show"],
    "calendar.connected": ["Connected Google Calendar {account}"],
    "calendar.disconnected": ["Disconnected Google Calendar"],
    "kb_document.deleted": [
      "Deleted knowledge-base document “{filename}” (retrieval chunks removed: {chunkCount})",
    ],
    "segment.created": ["Created segment “{segmentName}”"],
    "segment.updated": ["Updated segment {segmentId}"],
    "segment.deleted": ["Deleted segment {segmentId}"],
    "campaign.created": ["Created draft campaign “{campaignName}”"],
    "campaign.edited": ["Edited draft campaign “{campaignName}”"],
    "campaign.scheduled": [
      {
        text: "Scheduled campaign “{campaignName}” for {scheduledAt} (recipients: {recipientCount})",
        when: hasRecipients,
      },
      {
        text: "Scheduled campaign “{campaignName}” for {scheduledAt}; recipients are counted when it sends",
        when: noRecipientsYet,
      },
    ],
    "campaign.scheduled_immediate": [
      {
        text: "Scheduled campaign “{campaignName}” to send now (recipients: {recipientCount})",
        when: hasRecipients,
      },
      {
        text: "Scheduled campaign “{campaignName}” to send now; recipients are counted when it sends",
        when: noRecipientsYet,
      },
    ],
    "campaign.paused": ["Paused campaign “{campaignName}”"],
    "campaign.resumed": ["Resumed campaign “{campaignName}”"],
    "campaign.canceled": ["Canceled campaign “{campaignName}”"],
    "team.role_changed": ["Changed {email}'s role to {role}"],
    "team.member_removed": [
      "Removed member {userId} from the workspace (unresolved tickets released: {releasedTickets})",
    ],
    "customer.label_overridden": ["Set customer {customerId}'s label to “{label}”"],
    "customer.label_cleared": [
      "Cleared the label override on customer {customerId}, returning it to the agent",
    ],
    "consent.opted_out": ["Recorded an opt-out for {phone} on the customer's behalf"],
    "consent.opted_in": ["Recorded consent to message {phone} again"],
    "marketing_consent.opted_out": ["Recorded a marketing opt-out for customer {customerId}"],
    "marketing_consent.cleared": ["Cleared the marketing opt-out for customer {customerId}"],
  },
  ar: {
    "order.approved": ["وافق على الطلب {orderRef} ({total})"],
    "order.rejected": ["رفض الطلب {orderRef}: {reason}"],
    "order.cancelled": ["ألغى الطلب {orderRef}"],
    "order.store_push_requeued": ["أعاد إرسال الطلب {orderRef} إلى المتجر"],
    "order_settings.updated": [
      "ضبط وضع الطلبات على «{mode}» (الدفع عند الاستلام {cod}، مهلة الموافقة {approvalWindowHours})",
    ],
    "data_export.requested": ["طلب تصديرًا كاملًا للبيانات ({exportId})"],
    "data_export.downloaded": ["نزّل حزمة تصدير البيانات {exportId}"],
    "courier.connected": ["ربط حساب شركة الشحن {courier} رقم {accountRef}"],
    "courier.saved_inactive": ["حفظ حساب شركة الشحن {courier} رقم {accountRef} دون تفعيله"],
    "courier.deactivated": ["أوقف ربط شركة الشحن {connectionId}"],
    "courier.webhook_secret_rotated": [
      "جدّد المفتاح السري للويب هوك في ربط شركة الشحن {connectionId}",
    ],
    "shipment.recorded": ["سجّل شحنة {courier} ({trackingNumber}) للطلب {orderRef}"],
    "delivery_notifications.enabled": ["فعّل إشعارات التوصيل (الحالات المربوطة: {mappedStatuses})"],
    "delivery_notifications.disabled": ["أوقف إشعارات التوصيل (الحالات المربوطة: {mappedStatuses})"],
    "template_message.not_delivered": ["لم تُسلَّم رسالة القالب: {error}"],
    "workspace.closed": ["أغلق مساحة العمل؛ ستُمحى البيانات بعد {purgeAfter}"],
    "workspace.reopened": ["أعاد فتح مساحة العمل قبل موعد محو بياناتها"],
    "workspace.profile_updated": ["حدّث ملف مساحة العمل ({fields})"],
    "widget.updated": ["حدّث أداة الدردشة على الموقع ({enabled}، {origins} موقع مسموح)"],
    "widget.key_rotated": ["أصدر مفتاحًا جديدًا لأداة الدردشة على الموقع"],
    "booking_settings.updated": ["حدّث إعدادات الحجز (الوضع {mode}، المنطقة الزمنية {timeZone})"],
    "booking_service.created": ["أضاف خدمة الحجز «{serviceName}»"],
    "booking_service.updated": ["عدّل خدمة الحجز «{serviceName}»"],
    "booking.created": ["أضاف الحجز {bookingRef}: {service} في {when}"],
    "booking.confirmed": ["أكّد الحجز {bookingRef}"],
    "booking.cancelled": ["ألغى الحجز {bookingRef} {reason}"],
    "booking.completed": ["علّم الحجز {bookingRef} كمكتمل"],
    "booking.no_show": ["علّم الحجز {bookingRef} بعدم الحضور"],
    "calendar.connected": ["ربط تقويم Google {account}"],
    "calendar.disconnected": ["فصل تقويم Google"],
    "kb_document.deleted": ["حذف مستند قاعدة المعرفة «{filename}» (المقاطع المحذوفة: {chunkCount})"],
    "segment.created": ["أنشأ الشريحة «{segmentName}»"],
    "segment.updated": ["حدّث الشريحة {segmentId}"],
    "segment.deleted": ["حذف الشريحة {segmentId}"],
    "campaign.created": ["أنشأ مسودة الحملة «{campaignName}»"],
    "campaign.edited": ["عدّل مسودة الحملة «{campaignName}»"],
    "campaign.scheduled": [
      {
        text: "جدول الحملة «{campaignName}» في {scheduledAt} (عدد المستلمين: {recipientCount})",
        when: hasRecipients,
      },
      {
        text: "جدول الحملة «{campaignName}» في {scheduledAt}؛ يُحسب المستلمون عند الإرسال",
        when: noRecipientsYet,
      },
    ],
    "campaign.scheduled_immediate": [
      {
        text: "جدول الحملة «{campaignName}» للإرسال الفوري (عدد المستلمين: {recipientCount})",
        when: hasRecipients,
      },
      {
        text: "جدول الحملة «{campaignName}» للإرسال الفوري؛ يُحسب المستلمون عند الإرسال",
        when: noRecipientsYet,
      },
    ],
    "campaign.paused": ["أوقف الحملة «{campaignName}» مؤقتًا"],
    "campaign.resumed": ["استأنف الحملة «{campaignName}»"],
    "campaign.canceled": ["ألغى الحملة «{campaignName}»"],
    "team.role_changed": ["غيّر دور {email} إلى {role}"],
    "team.member_removed": [
      "أزال العضو {userId} من مساحة العمل (التذاكر غير المحلولة التي أُعيدت: {releasedTickets})",
    ],
    "customer.label_overridden": ["غيّر تصنيف العميل {customerId} إلى «{label}»"],
    "customer.label_cleared": ["ألغى تعديل تصنيف العميل {customerId} وأعاده إلى الوكيل"],
    "consent.opted_out": ["سجّل رفض المراسلة للرقم {phone} نيابةً عن العميل"],
    "consent.opted_in": ["سجّل الموافقة على مراسلة الرقم {phone} مجددًا"],
    "marketing_consent.opted_out": ["سجّل رفض الرسائل التسويقية للعميل {customerId}"],
    "marketing_consent.cleared": ["ألغى رفض الرسائل التسويقية للعميل {customerId}"],
  },
};

const COD_WORD: Record<Locale, Record<string, string>> = {
  en: { enabled: "on", disabled: "off" },
  ar: { enabled: "مفعّل", disabled: "متوقف" },
};

function isAuditDetailKey(key: string): key is AuditDetailKey {
  return Object.hasOwn(COPY.en, key);
}

function isCourier(value: string): value is Courier {
  return (COURIERS as readonly string[]).includes(value);
}

function roleLabel(role: string, t: Dictionary): string | null {
  if (role === "admin") return t.team.roleAdmin;
  if (role === "agent") return t.team.roleAgent;
  return null;
}

function leadLabel(label: string, t: Dictionary): string | null {
  if (label === "hot") return t.inbox.leadHot;
  if (label === "warm") return t.inbox.leadWarm;
  if (label === "cold") return t.inbox.leadCold;
  return null;
}

function formatParam(
  name: string,
  value: string | number,
  params: TemplateParams,
  t: Dictionary,
  locale: Locale,
): string {
  if (name === "approvalWindowHours" && typeof value === "number") {
    return formatDuration(value, "hour", locale);
  }
  if (name === "total" && typeof params.currency === "string") {
    return isolate(formatMoney(String(value), params.currency, locale));
  }
  if (typeof value === "string") {
    if (name === "courier" && isCourier(value)) return isolate(COURIER_BRAND[value]);
    if (name === "mode") return modeName(value, t);
    if (name === "cod") return COD_WORD[locale][value] ?? isolate(value);
    if (name === "role") return roleLabel(value, t) ?? isolate(value);
    if (name === "label") return leadLabel(value, t) ?? isolate(value);
    if (name === "purgeAfter" && !Number.isNaN(Date.parse(value))) {
      return isolate(formatDate(value, locale));
    }
    if (name === "scheduledAt" && !Number.isNaN(Date.parse(value))) {
      return isolate(formatDateTime(value, locale));
    }
  }
  return formatPlain(value, locale);
}

/** The audit entry's description in the reader's language, the API's English `detail`, or null when it has none. */
export function auditDetailText(
  entry: Pick<AuditLogEntry, "detail" | "detailKey" | "detailParams">,
  t: Dictionary,
  locale: Locale,
): string | null {
  const key = entry.detailKey;
  if (key && isAuditDetailKey(key)) {
    const params = entry.detailParams ?? {};
    const text = fillFirst(COPY[locale][key], params, (name, value) =>
      formatParam(name, value, params, t, locale),
    );
    if (text !== null) return text;
  }
  return entry.detail;
}
