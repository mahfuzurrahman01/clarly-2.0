"use client";

import { useRef } from "react";
import { CalendarDays, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Locale } from "@/lib/i18n/locale";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { LANGUAGE_DEMO, type LanguageDemo } from "@/lib/i18n/landing/language-demo";
import { Bubble, RichText } from "./phone";
import { gsap, inlineSign, landingMedia, offsetWithin, onceInView, scoped, ScrollTrigger, SCRUB, useGSAP } from "./motion";
import s from "./landing.module.css";

const GLYPH: Record<Locale, { text: string; className: string }> = {
  en: { text: "Aa", className: s.glyphLatin },
  ar: { text: "ع", className: s.glyphArabic },
};

/**
 * 05 · Language — the same conversation in the visitor's language, then the
 * other one: bubbles cross to their mirrored side as the text changes script.
 */
export function LanguageScene({ c, locale }: { c: LandingContent["language"]; locale: Locale }) {
  const root = useRef<HTMLElement>(null);
  const order: [Locale, Locale] = locale === "ar" ? ["ar", "en"] : ["en", "ar"];

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      const mm = landingMedia(el, {
        full: () => {
          const pair = one("[data-part=pair]");
          const firstRows = all("[data-part=first] [data-part=row]");
          const secondRows = all("[data-part=second] [data-part=row]");
          const knob = one("[data-part=knob]");
          const CROSS = 140;
          // -1 if the row sits on the left half of the card, +1 on the right.
          const side = (row: HTMLElement) => {
            const o = offsetWithin(row, pair);
            return o.x + o.w / 2 < pair.offsetWidth / 2 ? -1 : 1;
          };

          gsap.set(secondRows, { autoAlpha: 0 });
          gsap.set("[data-part=second] [data-part=chrome]", { autoAlpha: 0 });
          gsap.set("[data-part=glyph-second]", { autoAlpha: 0, scale: 0.8 });

          const tl = gsap.timeline({ defaults: { ease: "none" } });
          tl.from(firstRows, { autoAlpha: 0, y: 16, stagger: 0.15, duration: 0.5, ease: "power2.out" }, 0)
            .to(knob, { x: () => knob.offsetWidth * inlineSign(el), duration: 0.8, ease: "power3.inOut" }, 1.4)
            .to("[data-part=glyph-first]", { autoAlpha: 0, scale: 1.15, duration: 0.7 }, 1.4)
            .to("[data-part=glyph-second]", { autoAlpha: 1, scale: 1, duration: 0.8, ease: "power2.out" }, 1.7)
            .to("[data-part=first] [data-part=chrome]", { autoAlpha: 0, duration: 0.3 }, 1.5)
            .to("[data-part=second] [data-part=chrome]", { autoAlpha: 1, duration: 0.3 }, 1.8);
          // Leaving rows travel across to the other side; arriving rows come in from it.
          firstRows.forEach((row, i) =>
            tl.to(row, { x: () => -side(row) * CROSS, autoAlpha: 0, duration: 0.5, ease: "power2.in" }, 1.5 + i * 0.12),
          );
          secondRows.forEach((row, i) =>
            tl.fromTo(
              row,
              { x: () => -side(row) * CROSS, autoAlpha: 0 },
              { x: 0, autoAlpha: 1, duration: 0.6, ease: "power3.out" },
              1.9 + i * 0.12,
            ),
          );
          tl.to({}, { duration: 1 });

          ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: "+=2200",
            pin: true,
            scrub: SCRUB,
            animation: tl,
            invalidateOnRefresh: true,
          });
        },
        lite: () => {
          all("[data-part=reveal]").forEach((node) =>
            onceInView(node, () => gsap.from(node, { y: 28, autoAlpha: 0, duration: 0.8, ease: "power3.out" }), "top 90%"),
          );
        },
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} id="language" data-chapter={c.chapter} className={cn(s.scene, s.language)}>
      <div className={s.glyphs} aria-hidden>
        <span className={cn(s.glyph, GLYPH[order[0]].className)} data-part="glyph-first">
          {GLYPH[order[0]].text}
        </span>
        <span className={cn(s.glyph, s.glyphSecond, GLYPH[order[1]].className)} data-part="glyph-second">
          {GLYPH[order[1]].text}
        </span>
      </div>
      <div className={cn(s.wrap, s.pinwrap, s.lGrid)}>
        <div data-part="reveal">
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>
            <RichText parts={c.title} />
          </h2>
          <p className={s.lede}>{c.body}</p>
          <div className={s.lswitch} aria-hidden>
            <span className={s.lswitchKnob} data-part="knob" />
            {order.map((l) => (
              <span key={l} lang={l} className={s.lswitchLabel}>
                {LANGUAGE_DEMO[l].label}
              </span>
            ))}
          </div>
        </div>
        <div className={s.inboxPair} data-part="pair">
          <InboxCard demo={LANGUAGE_DEMO[order[0]]} locale={order[0]} part="first" />
          <InboxCard demo={LANGUAGE_DEMO[order[1]]} locale={order[1]} part="second" />
        </div>
      </div>
    </section>
  );
}

function InboxCard({ demo, locale, part }: { demo: LanguageDemo; locale: Locale; part: "first" | "second" }) {
  return (
    <div className={s.inbox} lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} data-part={part}>
      <div className={s.ibHead} data-part="chrome">
        <span className={cn(s.avatar, s.avatarSm)}>{demo.initial}</span>
        <div>
          <div className={s.ibName}>{demo.name}</div>
          <div className={s.ibPhone}>{demo.phone}</div>
        </div>
        <span className={cn(s.pill, s.pillAnswered, s.ibStatus)}>{demo.status}</span>
      </div>
      <div className={s.ibBody}>
        {demo.messages.map((m, i) => {
          if (m.kind === "cite")
            return (
              <div key={i} className={cn(s.meta, s.metaEnd)} data-part="row">
                <FileText className={s.icon} aria-hidden />
                <span>{m.text}</span>
              </div>
            );
          if (m.kind === "book")
            return (
              <div key={i} className={s.book} data-part="row">
                <CalendarDays className={s.icon} aria-hidden />
                {m.text}
              </div>
            );
          return (
            <Bubble key={i} kind={m.kind} data-part="row">
              {m.text}
            </Bubble>
          );
        })}
      </div>
      <div className={s.ibFoot} data-part="chrome">
        <span>{demo.footer[0]}</span>
        <span>{demo.footer[1]}</span>
      </div>
    </div>
  );
}
