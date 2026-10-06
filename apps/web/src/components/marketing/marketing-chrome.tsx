import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { getLocale } from "@/lib/i18n/locale";
import { COMPANY } from "@/lib/legal";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { WAITLIST_ONLY } from "@/lib/launch";
import { waitlistAction } from "@/components/marketing/landing/landing-action";

type NavLink = { href: string; label: string };

/**
 * Shared header for public pages. Pages can swap the nav (the landing page
 * links to its own sections) and the primary action; the brand, language
 * switcher and sign-in stay constant. `data-slot` lets a page re-tone the
 * header over dark surfaces (see the "Marketing header tone" rules in
 * globals.css) without this component knowing about it.
 *
 * A signed-in visitor gets a single "Dashboard" action in place of sign-in
 * and the page's CTA, so public pages don't look logged out.
 */
export async function MarketingHeader({
  t,
  links,
  cta,
  className,
}: {
  t: Dictionary;
  links?: NavLink[];
  cta?: NavLink;
  /** Positioning override, e.g. `fixed inset-x-0` over full-bleed scenes. */
  className?: string;
}) {
  const nav = links ?? [
    { href: "/product", label: t.landing.navProduct },
    { href: "/pricing", label: t.landing.navPricing },
  ];
  const signedIn = await isSignedIn();
  const action = signedIn
    ? { href: "/home", label: t.landing.openDashboard }
    : (cta ?? (WAITLIST_ONLY ? waitlistAction(t) : { href: "/signup", label: t.landing.getStarted }));
  // In-page anchors are plain <a> so smooth scrolling can intercept them.
  const isAnchor = (href: string) => href.startsWith("#");

  return (
    <header
      data-slot="marketing-header"
      className={cn(
        "sticky top-0 z-40 border-b border-border bg-background/80 text-foreground backdrop-blur",
        className,
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-6">
        <Link
          href="/"
          className="inline-flex items-baseline gap-1.5 font-display text-xl font-medium tracking-tight"
        >
          {t.common.brand}
          <span aria-hidden className="size-1.5 rounded-full bg-lime-ring" />
        </Link>
        <nav className="hidden divide-x divide-border border-x border-border text-sm text-muted-foreground md:flex rtl:divide-x-reverse">
          {nav.map((l) =>
            isAnchor(l.href) ? (
              <a key={l.href} href={l.href} className="px-5 transition-colors hover:text-foreground">
                {l.label}
              </a>
            ) : (
              <Link key={l.href} href={l.href} className="px-5 transition-colors hover:text-foreground">
                {l.label}
              </Link>
            ),
          )}
        </nav>
        <div className="flex items-center gap-1.5">
          <LocaleSwitcher />
          {!signedIn && !WAITLIST_ONLY && (
            <Button
              render={<Link href="/login" />}
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
            >
              {t.landing.signIn}
            </Button>
          )}
          <Button
            render={isAnchor(action.href) ? <a href={action.href} /> : <Link href={action.href} />}
            size="sm"
          >
            {action.label}
          </Button>
        </div>
      </div>
    </header>
  );
}

// getUser() revalidates the cookie with Supabase Auth (the middleware has
// already refreshed it on this request), so a revoked session reads as signed out.
async function isSignedIn(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user !== null;
}

export async function MarketingFooter({ t }: { t: Dictionary }) {
  // Meta business verification matches the operating entity on the website
  // against the portfolio's legal name, so it is shown on every public page.
  const locale = await getLocale();
  const operatedBy = t.landing.footerOperatedBy
    .replace("{company}", locale === "ar" ? COMPANY.legalNameAr : COMPANY.legalNameEn)
    .replace("{cr}", COMPANY.commercialRegistration);

  return (
    <footer className="relative z-10 border-t border-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
        <div className="flex flex-col items-center gap-1 sm:items-start">
          <span className="font-display">&copy; {new Date().getFullYear()} {t.common.brand}</span>
          <span className="text-xs">{operatedBy}</span>
        </div>
        <nav className="flex items-center divide-x divide-border border-x border-border rtl:divide-x-reverse">
          <Link
            href="/legal/terms"
            className="px-5 transition-colors hover:text-foreground"
          >
            {t.landing.footerTerms}
          </Link>
          <Link
            href="/legal/privacy"
            className="px-5 transition-colors hover:text-foreground"
          >
            {t.landing.footerPrivacy}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
