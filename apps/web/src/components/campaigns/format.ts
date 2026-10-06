import type { Locale } from "@/lib/i18n/locale";

/**
 * Formatting for the campaigns lane. Numbers are formatted with the reader's
 * locale before they are interpolated into a sentence, so an Arabic sentence
 * carries Arabic-Indic digits and the bidi algorithm has a number token
 * rather than a bare Latin run in the middle of RTL text.
 */

export function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Every campaign cost is an estimate from a static rate table — the copy around this always says so. */
export function formatUsd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDateTime(iso: string | null, locale: Locale): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** `{name}` substitution, the same convention the rest of the dictionary uses. */
export function fill(
  template: string,
  values: Record<string, string>,
): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    template,
  );
}

/**
 * A `<input type="datetime-local">` value for the browser's own timezone, and
 * back. `toISOString()` would shift the merchant's 9am to UTC and show them a
 * different hour than the one they typed.
 */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
