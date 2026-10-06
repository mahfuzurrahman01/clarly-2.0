import type { Metadata } from "next";
import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight, ShieldCheck, UserRound, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuraPage } from "@/components/marketing/aura/aura-page";
import { ChatDemo } from "@/components/marketing/aura/chat-demo";
import { CtaBand } from "@/components/marketing/aura/cta-band";
import { PageHero } from "@/components/marketing/aura/page-hero";
import { Reveal } from "@/components/marketing/aura/reveal";
import { StepExplorer } from "@/components/marketing/aura/step-explorer";
import s from "@/components/marketing/aura/aura.module.css";
import { primaryLandingAction } from "@/components/marketing/landing/landing-action";
import { PlatformSection } from "@/components/marketing/landing/platform-section";
import landing from "@/components/marketing/landing/landing.module.css";
import { getWaitlistAccessKey } from "@/lib/env";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getLandingContent } from "@/lib/i18n/landing";
import { getLocale } from "@/lib/i18n/locale";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getLocale());
  return { title: t.product.title, description: t.product.intro, alternates: { canonical: "/product" } };
}

/**
 * Product tour: a live conversation up top, then the three-step loop as an
 * interactive explorer, the platform bento from the landing page, and a close.
 */
export default async function ProductPage() {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const c = getLandingContent(locale);
  const primary = primaryLandingAction(t, getWaitlistAccessKey() !== null, { inPage: false });

  const chips = [
    { icon: Zap, text: c.answer.timeline[1].text },
    { icon: ShieldCheck, text: c.answer.chat.meta },
    { icon: UserRound, text: c.handoff.chat.tag },
  ];

  return (
    <AuraPage t={t} cta={primary} glows={["top", "end", "start"]}>
      <section className="mx-auto grid w-full max-w-6xl items-center gap-14 px-6 pt-16 pb-20 sm:pt-24 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <PageHero eyebrow={t.product.eyebrow} title={t.product.title} lede={t.product.intro}>
          <Button render={<Link href={primary.href} />} size="lg" className="h-11 px-5">
            {primary.label}
            <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
          </Button>
          <Button render={<a href="#how" />} variant="ghost" size="lg" className="h-11 px-5">
            {c.night.howItWorks}
          </Button>
        </PageHero>

        <div className={cn(s.authStage, s.rise)} style={{ "--i": 2 } as CSSProperties}>
          {chips.map(({ icon: Icon, text }, i) => (
            <span
              key={text}
              className={cn(s.glass, s.floatChip)}
              style={{ "--i": i } as CSSProperties}
              aria-hidden
            >
              <Icon />
              {text}
            </span>
          ))}
          <ChatDemo answer={c.answer.chat} handoff={c.handoff.chat} label={c.answer.phoneLabel} height="36rem" />
        </div>
      </section>

      <section id="how" className="mx-auto w-full max-w-6xl scroll-mt-24 px-6 py-20 sm:py-28">
        <Reveal className="mb-12 max-w-2xl">
          <p className={cn("eyebrow", s.eyebrow)}>{c.night.howItWorks}</p>
          <h2 className={cn(s.title, s.titleSm, "mt-4")}>
            {t.auth.quoteLine1} {t.auth.quoteLine2Prefix}
            <em className={s.em}>{t.auth.quoteLine2What}</em>.
          </h2>
        </Reveal>
        <Reveal index={1}>
          <StepExplorer
            steps={[
              { title: t.product.step1Title, body: t.product.step1Body },
              { title: t.product.step2Title, body: t.product.step2Body },
              { title: t.product.step3Title, body: t.product.step3Body },
            ]}
            c={c}
          />
        </Reveal>
      </section>

      <div className={landing.tokens}>
        {/* Landing eyebrows are numbered chapters; out of the story, just the name. */}
        <PlatformSection c={{ ...c.platform, eyebrow: c.platform.chapter }} guards={c.handoff.guards} numbers={c.numbers} />
      </div>

      <CtaBand title={t.product.ctaTitle} body={t.product.ctaBody} action={primary} />
    </AuraPage>
  );
}
