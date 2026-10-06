import type { Locale } from "@/lib/i18n/locale";

/** Intl locale for our console locales. Arabic uses Latin digits for times, like the rest of the console. */
function intlLocale(locale: Locale): string {
  return locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB";
}

/** "Thu 8 Oct" in the booking's own zone. */
export function formatBookingDay(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

/** "16:30" in the booking's own zone. */
export function formatBookingTime(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** `YYYY-MM-DD` of an instant in a zone — the grouping key for the agenda. */
export function dayKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return parts;
}

/** Today's `YYYY-MM-DD` in a zone. */
export function todayIn(timeZone: string, nowMs: number): string {
  return dayKey(new Date(nowMs).toISOString(), timeZone);
}

export function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
}

export function formatPrice(price: string | null, currency: string | null, locale: Locale): string | null {
  if (price === null) return null;
  const amount = Number(price);
  if (!Number.isFinite(amount)) return price;
  if (!currency) return amount.toLocaleString(intlLocale(locale));
  try {
    return new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency }).format(amount);
  } catch {
    return `${price} ${currency}`;
  }
}
