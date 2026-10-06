"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { getClientLocale, localeDir } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import "./globals.css";

/**
 * Catches errors thrown by the root layout itself (a regular error.tsx
 * boundary can't — it renders *inside* the layout it's scoped to). Because
 * of that, this file fully replaces <html>/<body> when it renders, so it
 * can't rely on RootLayout's providers (ThemeProvider, I18nProvider) being
 * mounted — locale is read straight from the cookie instead.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = getClientLocale();
  const t = getDictionary(locale);

  useEffect(() => {
    // Sentry is a no-op when NEXT_PUBLIC_SENTRY_DSN is unset.
    Sentry.captureException(error);
    if (process.env.NODE_ENV !== "production") {
      console.error(error);
    }
  }, [error]);

  return (
    <html lang={locale} dir={localeDir(locale)} className="antialiased">
      <body className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-foreground">
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <p className="font-display text-xl font-medium tracking-tight">
            {t.common.brand}
          </p>
          <h1 className="font-display text-3xl font-medium tracking-tight">
            {t.globalError.title}
          </h1>
          <p className="text-sm text-muted-foreground">{t.globalError.body}</p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-lime-ring/50 bg-gradient-to-b from-lime to-lime-ring px-3 text-sm font-medium text-lime-foreground shadow-[0_2px_10px_-2px_var(--lime-ring)] transition-all hover:brightness-105"
            >
              {t.globalError.tryAgain}
            </button>
            <button
              type="button"
              // Intentionally a hard navigation, not useRouter()/<Link>: this
              // boundary can render when the root layout itself threw, so
              // the router context it'd need isn't guaranteed to exist.
              onClick={() => window.location.assign("/")}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              {t.globalError.backHome}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
