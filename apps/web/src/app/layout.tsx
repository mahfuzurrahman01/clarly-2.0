import type { Metadata } from "next";
import {
  Fraunces,
  Hanken_Grotesk,
  IBM_Plex_Sans_Arabic,
  JetBrains_Mono,
  Noto_Naskh_Arabic,
} from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { getLocale, localeDir } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { I18nProvider } from "@/lib/i18n/provider";
import { getPublicEnv } from "@/lib/env";
import { CookieConsentBanner } from "@/components/shell/cookie-consent-banner";
import "./globals.css";

// Font variables are raw faces; globals.css composes them into the
// --app-font-* stacks per language (Latin faces first in English, Arabic faces
// first under :lang(ar)), so no component has to know which script it renders.

// Display serif with tension for headlines.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

// Clean grotesk body/UI — deliberately not Inter.
const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Mono for eyebrow labels, tags, timestamps.
const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

// Arabic body/UI — the grotesk's counterpart: open, even, legible at UI sizes.
const plexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-plex-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
});

// Arabic display — a Naskh, the calligraphic counterpart to Fraunces' editorial serif.
const naskhArabic = Noto_Naskh_Arabic({
  variable: "--font-naskh-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
});

// Title, description and social cards follow the visitor's language, so a
// shared link reads in Arabic when it was copied from the Arabic site.
export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getLocale());
  const title = t.common.metaTitle;
  const description = t.common.metaDescription;
  return {
    metadataBase: new URL(getPublicEnv().NEXT_PUBLIC_SITE_URL),
    title: { default: title, template: `%s — ${t.common.brand}` },
    description,
    openGraph: { title, description, siteName: t.common.brand, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const dictionary = getDictionary(locale);
  const cookieConsentEnabled = getPublicEnv().NEXT_PUBLIC_COOKIE_CONSENT_ENABLED;

  return (
    <html
      lang={locale}
      dir={localeDir(locale)}
      suppressHydrationWarning
      className={`${fraunces.variable} ${hankenGrotesk.variable} ${jetBrainsMono.variable} ${plexArabic.variable} ${naskhArabic.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Barely-there grain over the whole app for tactility. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 bg-grain opacity-[0.035] mix-blend-multiply"
        />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <I18nProvider dictionary={dictionary} locale={locale}>
            {children}
            <Toaster position="top-center" />
            {cookieConsentEnabled ? <CookieConsentBanner /> : null}
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
