import type { Metadata } from "next";
import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuraPage } from "@/components/marketing/aura/aura-page";
import { PageHero } from "@/components/marketing/aura/page-hero";
import { Reveal } from "@/components/marketing/aura/reveal";
import { Spotlight } from "@/components/marketing/aura/spotlight";
import { FaqSection } from "@/components/marketing/landing/faq-section";
import { primaryLandingAction } from "@/components/marketing/landing/landing-action";
import landing from "@/components/marketing/landing/landing.module.css";
import { PricingPlans } from "@/components/marketing/pricing-plans";
import { getWaitlistAccessKey } from "@/lib/env";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getLandingContent } from "@/lib/i18n/landing";
import { getLocale } from "@/lib/i18n/locale";
import { WAITLIST_ONLY } from "@/lib/launch";

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getLocale());
  return { title: t.pricing.title, description: t.pricing.intro, alternates: { canonical: "/pricing" } };
}

export default async function PricingPage() {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const c = getLandingContent(locale);
  const primary = primaryLandingAction(t, getWaitlistAccessKey() !== null, { inPage: false });

  return (
    <AuraPage t={t} cta={primary} glows={["top", "end"]}>
      <section className="mx-auto w-full max-w-6xl px-6 pt-20 pb-12 sm:pt-28">
        <PageHero
          eyebrow={t.pricing.eyebrow}
          title={t.pricing.title}
          lede={t.pricing.intro}
          align="center"
          className="max-w-3xl"
        />

        <PricingPlans
          t={t}
          action={WAITLIST_ONLY ? primary : { href: "/signup", label: t.pricing.startTrialCta }}
        />

        <Reveal className="mt-6">
          <Spotlight className="flex flex-col gap-5 p-8 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-lime-soft/60 text-lime-foreground dark:bg-lime/15 dark:text-lime">
                <MessageCircle className="size-5" aria-hidden />
              </span>
              <div>
                <p className="font-display text-xl font-medium tracking-tight">{t.pricing.talkTitle}</p>
                <p className="mt-1 max-w-xl text-muted-foreground">{t.pricing.talkBody}</p>
              </div>
            </div>
            <Button render={<Link href={WAITLIST_ONLY ? primary.href : "/signup"} />} variant="outline" size="lg" className="h-11 w-fit shrink-0 px-5">
              {t.pricing.talkCta}
            </Button>
          </Spotlight>
        </Reveal>
      </section>

      <div className={landing.tokens}>
        {/* Landing eyebrows are numbered chapters; out of the story, just the name. */}
        <FaqSection c={{ ...c.faq, eyebrow: c.faq.chapter }} />
      </div>
    </AuraPage>
  );
}
