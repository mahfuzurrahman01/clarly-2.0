import { LOCALE_COOKIE, type Locale } from "./locale";

/**
 * Persists the visitor's language choice. Client-only (touches document.cookie);
 * callers follow it with router.refresh() so Server Components re-render in the
 * new locale — the root layout reads this same cookie.
 */
export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
