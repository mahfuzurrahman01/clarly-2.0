import { AuraPage } from "@/components/marketing/aura/aura-page";
import { PageHero } from "@/components/marketing/aura/page-hero";
import { Reveal } from "@/components/marketing/aura/reveal";
import s from "@/components/marketing/aura/aura.module.css";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getLocale } from "@/lib/i18n/locale";
import {
  getLegalDocument,
  LEGAL_LAST_UPDATED,
  type LegalDocumentKind,
  type LegalSection,
} from "@/lib/legal";
import { cn } from "@/lib/utils";

interface LegalPageProps {
  kind: LegalDocumentKind;
}

export async function LegalPage({ kind }: LegalPageProps) {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const doc = getLegalDocument(kind, locale);
  const title = kind === "privacy" ? t.legal.privacyTitle : t.legal.termsTitle;
  const lastUpdated = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(LEGAL_LAST_UPDATED));

  return (
    <AuraPage t={t} glows={["top"]}>
      <article className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-28">
        <PageHero
          eyebrow={t.legal.lastUpdatedTemplate.replace("{date}", lastUpdated)}
          title={title}
          size="sm"
        />
        <Reveal className={cn(s.glass, "mt-12 p-7 sm:p-10")}>
          <div className="space-y-4 leading-relaxed text-muted-foreground">
            {doc.intro.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          {doc.sections.map((section) => (
            <LegalSectionBlock key={section.heading} section={section} />
          ))}
        </Reveal>
      </article>
    </AuraPage>
  );
}

function LegalSectionBlock({ section }: { section: LegalSection }) {
  return (
    <section className="mt-10 border-t border-border pt-8 first-of-type:mt-10">
      <h2 className="font-display text-xl font-medium tracking-tight text-foreground">
        {section.heading}
      </h2>
      <div className="mt-3 space-y-3 leading-relaxed text-muted-foreground">
        {section.paragraphs?.map((p) => <p key={p}>{p}</p>)}
        {section.bullets && (
          <ul className="list-disc space-y-2 ps-5 marker:text-lime-text">
            {section.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {section.after?.map((p) => <p key={p}>{p}</p>)}
      </div>
    </section>
  );
}
