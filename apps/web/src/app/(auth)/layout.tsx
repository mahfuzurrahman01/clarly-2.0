import type { Metadata } from "next";
import Link from "next/link";
import { AuthPanel } from "@/components/auth/auth-panel";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { AuraSky } from "@/components/marketing/aura/aura-sky";
import s from "@/components/marketing/aura/aura.module.css";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getLandingContent } from "@/lib/i18n/landing";
import { cn } from "@/lib/utils";
import { WAITLIST_ONLY } from "@/lib/launch";

// Hidden during the waitlist-only launch: reachable by URL for the team, kept
// out of search results.
export const metadata: Metadata = WAITLIST_ONLY ? { robots: { index: false, follow: false } } : {};

export default async function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const c = getLandingContent(locale);

  return (
    <div className={cn(s.surface, "grid min-h-svh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]")}>
      {/* Brand panel — live product demo. Hidden on small screens. */}
      <AuthPanel t={t} c={c} />

      {/* Form side */}
      <main className="relative flex flex-col justify-center overflow-hidden px-6 py-16">
        <AuraSky glows={["top"]} className="lg:opacity-60" />
        <LocaleSwitcher className="absolute end-4 top-4" />
        <div className={cn(s.authForm, "relative mx-auto w-full max-w-sm")}>
          <Link
            href="/"
            className="mb-10 inline-flex items-baseline gap-1.5 font-display text-xl font-medium tracking-tight lg:hidden"
          >
            {t.common.brand}
            <span aria-hidden className="size-1.5 rounded-full bg-lime-ring" />
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
