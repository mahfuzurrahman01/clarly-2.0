import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { Locale } from "@/lib/i18n/locale";
import type {
  Courier,
  OrderStatus,
  ShipmentStatus,
  StatusSource,
} from "@/lib/api/delivery";
import { COURIER_BRAND } from "@/lib/api/delivery";

/**
 * Arabic here is pinned to `ar-AE-u-nu-latn-ca-gregory` rather than plain
 * `ar`: a delivery console is read next to a courier's own portal, and those
 * show Gregorian dates in Latin digits. Defaulting to `ar` would hand a Saudi
 * tenant Hijri dates in Arabic-Indic digits that no tracking page agrees with.
 */
function intlLocale(locale: Locale): string {
  return locale === "ar" ? "ar-AE-u-nu-latn-ca-gregory" : "en-GB";
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const DATE_ONLY: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

export function formatDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), DATE_TIME).format(
    new Date(iso),
  );
}

export function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), DATE_ONLY).format(
    new Date(iso),
  );
}

/** `null` timestamps are the norm on this feature — the caller supplies the word for "never". */
export function formatDateTimeOr(
  iso: string | null,
  locale: Locale,
  fallback: string,
): string {
  return iso ? formatDateTime(iso, locale) : fallback;
}

export function courierLabel(courier: Courier): string {
  return COURIER_BRAND[courier];
}

export function shipmentStatusLabel(
  t: Dictionary,
  status: ShipmentStatus,
): string {
  const labels: Record<ShipmentStatus, string> = {
    label_created: t.delivery.status.labelCreated,
    picked_up: t.delivery.status.pickedUp,
    in_transit: t.delivery.status.inTransit,
    out_for_delivery: t.delivery.status.outForDelivery,
    delivered: t.delivery.status.delivered,
    failed_attempt: t.delivery.status.failedAttempt,
    returned: t.delivery.status.returned,
    cancelled: t.delivery.status.cancelled,
    exception: t.delivery.status.exception,
    unknown: t.delivery.status.unknown,
  };
  return labels[status];
}

export function orderStatusLabel(t: Dictionary, status: OrderStatus): string {
  const labels: Record<OrderStatus, string> = {
    pending_approval: t.delivery.orderStatus.pendingApproval,
    confirmed: t.delivery.orderStatus.confirmed,
    rejected: t.delivery.orderStatus.rejected,
    expired: t.delivery.orderStatus.expired,
    cancelled: t.delivery.orderStatus.cancelled,
    fulfilled: t.delivery.orderStatus.fulfilled,
    failed: t.delivery.orderStatus.failed,
  };
  return labels[status];
}

export function sourceLabel(t: Dictionary, source: StatusSource): string {
  const labels: Record<StatusSource, string> = {
    poll: t.delivery.source.poll,
    webhook: t.delivery.source.webhook,
    manual: t.delivery.source.manual,
  };
  return labels[source];
}

/** Credential field label/hint lookup, keyed `<courier><FieldKey>` in the dictionary. */
export function credentialLabel(
  t: Dictionary,
  courier: Courier,
  field: string,
): string {
  const key = `${courier}${field[0].toUpperCase()}${field.slice(1)}`;
  const labels = t.delivery.credentials as Record<string, string>;
  return labels[key] ?? field;
}

export function credentialHint(
  t: Dictionary,
  courier: Courier,
  field: string,
): string | null {
  const key = `${courier}${field[0].toUpperCase()}${field.slice(1)}Hint`;
  const labels = t.delivery.credentials as Record<string, string>;
  return labels[key] ?? null;
}
