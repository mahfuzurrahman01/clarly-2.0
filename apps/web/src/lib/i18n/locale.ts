export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Locale used when the visitor hasn't chosen one (no cookie yet). Arabic-first:
 * the product is built for GCC businesses, so a first visit renders in Arabic,
 * right to left, and the language switcher offers English.
 */
export const DEFAULT_LOCALE: Locale = "ar";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

export const LOCALE_COOKIE = "locale";

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** Resolves a raw cookie value to a supported locale, falling back to DEFAULT_LOCALE. */
export function resolveLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function localeDir(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Server Component / Route Handler helper — reads the locale cookie directly, same resolution root layout uses. */
export async function getLocale(): Promise<Locale> {
  const { cookies } = await import("next/headers");
  return resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

/**
 * Client-side equivalent of getLocale() — reads document.cookie directly
 * instead of going through the I18nProvider context. For code that can't
 * rely on that context being mounted (global-error.tsx, which replaces the
 * whole app tree including the root layout on error) or that needs the
 * value before the provider hydrates.
 */
export function getClientLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`),
  );
  return resolveLocale(match ? decodeURIComponent(match[1]) : undefined);
}
