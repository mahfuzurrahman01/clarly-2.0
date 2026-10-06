import { MarketingFooter, MarketingHeader } from "@/components/marketing/marketing-chrome";
import { AnswerScene } from "@/components/marketing/landing/answer-scene";
import { ChapterRail, type Chapter } from "@/components/marketing/landing/chapter-rail";
import { CtaSection } from "@/components/marketing/landing/cta-section";
import { FaqSection } from "@/components/marketing/landing/faq-section";
import { HandoffScene } from "@/components/marketing/landing/handoff-scene";
import { primaryLandingAction } from "@/components/marketing/landing/landing-action";
import { KnowledgeScene } from "@/components/marketing/landing/knowledge-scene";
import { LanguageScene } from "@/components/marketing/landing/language-scene";
import { MotionBootScript } from "@/components/marketing/landing/motion-boot-script";
import { NightScene } from "@/components/marketing/landing/night-scene";
import { PlatformSection } from "@/components/marketing/landing/platform-section";
import { PricingSection } from "@/components/marketing/landing/pricing-section";
import { PrincipleScene } from "@/components/marketing/landing/principle-scene";
import { ReviewsSection } from "@/components/marketing/landing/reviews-section";
import { SetupScene } from "@/components/marketing/landing/setup-scene";
import { SmoothScroll } from "@/components/marketing/landing/smooth-scroll";
import s from "@/components/marketing/landing/landing.module.css";
import { getWaitlistAccessKey } from "@/lib/env";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getLandingContent } from "@/lib/i18n/landing";
import { getLocale, localeDir } from "@/lib/i18n/locale";

/**
 * Public landing page — a scroll story told through one clinic's night:
 * unanswered messages → Clarly reads the clinic's documents → answers with
 * sources → hands off what it shouldn't answer → speaks both languages →
 * the platform, setup, proof, pricing, FAQ, and the morning after.
 */
export default async function LandingPage() {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const c = getLandingContent(locale);
  // Web3Forms waitlist (see components/marketing/waitlist-form.tsx). Unset key
  // → the form is hidden and every CTA falls back to signup.
  const waitlistAccessKey = getWaitlistAccessKey();
  const primary = primaryLandingAction(t, waitlistAccessKey !== null);

  const chapters: Chapter[] = [
    { id: "top", label: c.night.chapter },
    { id: "knowledge", label: c.knowledge.chapter },
    { id: "answer", label: c.answer.chapter },
    { id: "handoff", label: c.handoff.chapter },
    { id: "principle", label: c.principle.chapter },
    { id: "language", label: c.language.chapter },
    { id: "platform", label: c.platform.chapter },
    { id: "setup", label: c.setup.chapter },
    { id: "pricing", label: c.pricing.chapter },
    { id: "faq", label: c.faq.chapter },
  ];

  return (
    <div className="relative flex min-h-full flex-col">
      <MotionBootScript />
      <MarketingHeader
        t={t}
        className="fixed inset-x-0"
        links={[
          { href: "#knowledge", label: c.nav.story },
          { href: "#platform", label: c.nav.platform },
          { href: "#pricing", label: c.nav.pricing },
          { href: "#faq", label: c.nav.faq },
        ]}
        cta={primary}
      />

      {/* Keyed by locale: switching language flips the page direction, and every
          scene measures layout (positions, inline direction) when it mounts —
          remounting rebuilds them against the new direction. */}
      <main key={locale} className={s.root}>
        <NightScene c={c.night} primary={primary} />
        <KnowledgeScene c={c.knowledge} />
        <AnswerScene c={c.answer} />
        <HandoffScene c={c.handoff} />
        <PrincipleScene c={c.principle} />
        <LanguageScene c={c.language} locale={locale} />
        <PlatformSection c={c.platform} guards={c.handoff.guards} numbers={c.numbers} />
        <SetupScene c={c.setup} />
        <ReviewsSection c={c.reviews} dir={localeDir(locale)} />
        <PricingSection c={c.pricing} actionHref={primary.href} />
        <FaqSection c={c.faq} />
        <CtaSection c={c.cta} waitlistAccessKey={waitlistAccessKey} fallback={primary} />
        <ChapterRail label={c.rail.label} chapters={chapters} />
      </main>

      <MarketingFooter t={t} />
      <SmoothScroll refreshKey={locale} />
    </div>
  );
}
