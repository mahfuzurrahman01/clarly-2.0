import type { Locale } from "@/lib/i18n/locale";
import type { ProductRecord } from "@/lib/api/catalog";

/**
 * `price` arrives as a decimal string. It is formatted, never arithmetic'd:
 * an unparseable value falls back to the raw string so a merchant sees what
 * is actually stored rather than "NaN" or a silent 0.
 */
export function formatPrice(
  price: string,
  currency: string,
  locale: Locale,
): string {
  const amount = Number(price);
  if (!Number.isFinite(amount)) return price;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    // Unknown currency code on an older row — show it plainly rather than throw.
    return `${amount} ${currency}`;
  }
}

/** Arabic readers see `nameAr` when the merchant supplied one; English name is the fallback everywhere. */
export function productName(product: ProductRecord, locale: Locale): string {
  if (locale === "ar" && product.nameAr?.trim()) return product.nameAr;
  return product.name;
}

/** The other-language name, when there is one worth showing under the primary. */
export function productSecondaryName(
  product: ProductRecord,
  locale: Locale,
): string | null {
  const secondary = locale === "ar" ? product.name : product.nameAr;
  if (!secondary?.trim()) return null;
  return secondary === productName(product, locale) ? null : secondary;
}

/** Builds a CSV download in the browser: the export endpoint returns JSON, not a file stream. */
export function downloadCsv(csv: string, filename: string): void {
  // BOM so Excel opens Arabic product names as UTF-8 instead of mojibake.
  const blob = new Blob([`﻿${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
