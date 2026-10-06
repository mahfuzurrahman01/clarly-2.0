"use client";

import { createContext, useContext } from "react";
import type { Dictionary } from "./get-dictionary";
import type { Locale } from "./locale";

const I18nContext = createContext<{
  t: Dictionary;
  locale: Locale;
} | null>(null);

export function I18nProvider({
  dictionary,
  locale,
  children,
}: {
  dictionary: Dictionary;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <I18nContext.Provider value={{ t: dictionary, locale }}>
      {children}
    </I18nContext.Provider>
  );
}

/** Translated strings for the current locale, resolved server-side and passed down — never re-read client-side, so there's no hydration flicker. */
export function useTranslations(): Dictionary {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslations must be used within I18nProvider");
  return ctx.t;
}

export function useLocale(): Locale {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLocale must be used within I18nProvider");
  return ctx.locale;
}
