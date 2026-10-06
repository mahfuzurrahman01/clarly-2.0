"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { gsap, landingMedia, onceInView, scoped, ScrollTrigger, SCRUB, setHeaderTone, useGSAP } from "./motion";
import s from "./landing.module.css";

/** 04 · Principle — the product's one rule, lit word by word on a dark band. */
export function PrincipleScene({ c }: { c: LandingContent["principle"] }) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current!;
      const { all } = scoped(el);
      const words = all("[data-part=word]");

      // The header darkens while this band is under it. When pinned, the band
      // lives inside a pin spacer that spans the whole pinned distance.
      const toneWhileUnderHeader = (trigger: Element) =>
        ScrollTrigger.create({
          trigger,
          start: "top top+=32",
          end: "bottom top+=32",
          onToggle: (st) => setHeaderTone(st.isActive ? "night" : "page"),
        });

      const mm = landingMedia(el, {
        full: () => {
          gsap.set(words, { opacity: 0.14 });
          gsap.set("[data-part=body]", { autoAlpha: 0, y: 20 });
          const tl = gsap.timeline({ defaults: { ease: "none" } });
          tl.to(words, { opacity: 1, stagger: 0.35, duration: 0.6 })
            .fromTo("[data-part=sig]", { scale: 0 }, { scale: 1, duration: 0.4, ease: "back.out(3)" }, ">-0.1")
            .to("[data-part=body]", { autoAlpha: 1, y: 0, duration: 0.6 }, ">")
            .to({}, { duration: 0.8 });
          const pin = ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: "+=1800",
            pin: true,
            scrub: SCRUB,
            animation: tl,
          });
          toneWhileUnderHeader(pin.pin?.parentElement ?? el);
        },
        lite: () => {
          toneWhileUnderHeader(el);
          onceInView(el, () => gsap.from(words, { opacity: 0.15, stagger: 0.08, duration: 0.5 }), "top 80%");
        },
        off: () => {
          toneWhileUnderHeader(el);
        },
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const lastIndex = c.words.length - 1;
  return (
    <section ref={root} id="principle" data-chapter={c.chapter} className={cn(s.scene, s.principle)}>
      <div className={cn(s.wrap, s.pinwrap)}>
        <div>
          <p className={cn("eyebrow", s.principleEyebrow)}>{c.eyebrow}</p>
          <blockquote className={s.pq}>
            {c.words.map((w, i) => (
              <span key={i}>
                {i > 0 ? " " : null}
                <span className={cn(s.pw, w.em && s.pwEm)} data-part="word">
                  {w.text}
                  {i === lastIndex ? <span className={s.sig} data-part="sig" aria-hidden /> : null}
                </span>
              </span>
            ))}
          </blockquote>
          <p className={s.principleBody} data-part="body">
            {c.body}
          </p>
        </div>
      </div>
    </section>
  );
}
