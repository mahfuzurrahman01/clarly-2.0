import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { Check, Clock } from "lucide-react";
import { AuraPage } from "@/components/marketing/aura/aura-page";
import { PageHero } from "@/components/marketing/aura/page-hero";
import { Spotlight } from "@/components/marketing/aura/spotlight";
import s from "@/components/marketing/aura/aura.module.css";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { getWaitlistAccessKey } from "@/lib/env";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getLandingContent } from "@/lib/i18n/landing";
import { getLocale } from "@/lib/i18n/locale";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getLocale());
  return {
    title: t.landing.waitlistTitle,
    description: t.landing.waitlistBody,
    alternates: { canonical: "/waitlist" },
  };
}

/**
 * Standalone waitlist page — the same Web3Forms form as the landing page's
 * closing section, and the one door in during the waitlist-only launch (every
 * CTA and the closed auth pages lead here). Without a Web3Forms key there is
 * no form to show, so it says the waitlist opens shortly instead.
 */
export default async function WaitlistPage() {
  const accessKey = getWaitlistAccessKey();

  const locale = await getLocale();
  const t = getDictionary(locale);
  // "Early access · free · no card" → three reassurance points.
  const points = getLandingContent(locale).night.note.split("·").map((p) => p.trim()).filter(Boolean);

  return (
    <AuraPage t={t} glows={["top", "end", "start"]} mainClassName="flex items-center">
      <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 py-20 sm:py-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
        <PageHero eyebrow={t.landing.waitlistEyebrow} title={t.landing.waitlistTitle} lede={t.landing.waitlistBody}>
          <ul className="flex flex-wrap gap-2.5">
            {points.map((p) => (
              <li key={p} className={cn(s.glass, "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm")}>
                <Check className="size-3.5 text-lime-text" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </PageHero>

        <div className={cn(s.rise, s.authForm)} style={{ "--i": 3 } as CSSProperties}>
          <Spotlight className="rounded-2xl">
            {accessKey ? (
              <WaitlistForm accessKey={accessKey} className="border-0 bg-transparent" />
            ) : (
              <div role="status" className="flex items-start gap-3 p-8 text-muted-foreground">
                <Clock className="mt-0.5 size-5 shrink-0 text-lime-text" aria-hidden />
                <p>{t.landing.waitlistUnavailable}</p>
              </div>
            )}
          </Spotlight>
        </div>
      </section>
    </AuraPage>
  );
}
