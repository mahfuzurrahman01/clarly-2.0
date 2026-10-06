"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { Check, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { gsap, inlineSign, landingMedia, onceInView, pad2, scoped, ScrollTrigger, SCRUB, useGSAP } from "./motion";
import s from "./landing.module.css";

/** 07 · Setup — the four real onboarding steps, scrolled sideways while pinned. */
export function SetupScene({ c }: { c: LandingContent["setup"] }) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      const mm = landingMedia(el, {
        full: () => {
          const track = one("[data-part=track]");
          // How far the track must travel for its far end to reach the content edge.
          const distance = () => {
            const box = track.parentElement!;
            const cs = getComputedStyle(box);
            const visible = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            return Math.max(0, track.scrollWidth - visible);
          };
          const tl = gsap.timeline({ defaults: { ease: "none" } });
          tl.to(track, { x: () => -distance() * inlineSign(el), duration: 1 }, 0).to("[data-part=progress]", { scaleX: 1, duration: 1 }, 0);
          ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: () => `+=${distance() + window.innerHeight * 0.4}`,
            pin: true,
            scrub: SCRUB,
            animation: tl,
            invalidateOnRefresh: true,
          });
          onceInView(el, () => gsap.from(all("[data-part=panel]"), { y: 40, autoAlpha: 0, stagger: 0.1, duration: 0.8, ease: "power3.out" }), "top 70%");
        },
        lite: () => {
          all("[data-part=panel]").forEach((panel) =>
            onceInView(panel, () => gsap.from(panel, { y: 28, autoAlpha: 0, duration: 0.8, ease: "power3.out" }), "top 90%"),
          );
        },
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const visuals: ReactNode[] = [
    <div key="upload" className={cn(s.sViz, s.up)}>
      {c.upload.files.map((f, i) => (
        <div key={f.name} className={s.upFile}>
          <div className={s.upTop}>
            <span dir="auto">{f.name}</span>
            <span className="eyebrow">{f.count}</span>
          </div>
          <div className={s.upBar}>
            <i style={{ "--i": i } as CSSProperties} />
          </div>
        </div>
      ))}
    </div>,
    <div key="rules" className={s.sViz}>
      <div className={s.chips}>
        {c.rules.tones.map((t) => (
          <span key={t.label} className={cn(s.chip, t.on && s.chipOn)}>
            {t.label}
          </span>
        ))}
      </div>
      <div className={s.slider}>
        <div className={s.sliderLabel}>
          <span className="eyebrow">{c.rules.threshold}</span>
          <b>0.70</b>
        </div>
        <div className={s.sliderTrack} aria-hidden>
          <div className={s.sliderFill} />
          <div className={s.sliderKnob} />
        </div>
      </div>
    </div>,
    <div key="connect" className={s.sViz}>
      <ul className={s.checks}>
        {c.connect.checks.map((ch) => (
          <li key={ch.label}>
            <span className={cn(s.checkDot, !ch.done && s.checkWait)}>{ch.done ? <Check className={s.icon} aria-hidden /> : null}</span>
            {ch.label}
            <span className={s.checkMeta}>{ch.meta}</span>
          </li>
        ))}
      </ul>
    </div>,
    <div key="live" className={s.sViz}>
      <div className={s.shift}>
        <span className="inline-flex items-center gap-2">
          <Moon className={s.icon} aria-hidden />
          {c.live.label}
        </span>
        <span className={s.toggle} aria-hidden />
      </div>
      <div className={cn(s.shift, s.shiftMuted)}>
        <span>{c.live.agent}</span>
        <span>{c.live.version}</span>
      </div>
    </div>,
  ];

  return (
    <section ref={root} id="setup" data-chapter={c.chapter} className={cn(s.scene, s.setup)}>
      <div className={cn(s.pinwrap, s.setupWrap)}>
        <div className={s.wrap}>
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>{c.title}</h2>
        </div>
        <div className={s.wrap}>
          <ol className={cn(s.sTrack, "m-0 list-none p-0")} data-part="track">
            {c.steps.map((step, i) => (
              <li key={step.title} className={cn(s.sPanel, i === c.steps.length - 1 && s.sPanelLast)} data-part="panel">
                <div>
                  <div className={cn("eyebrow", s.sNum)}>
                    {c.stepWord} {pad2(i + 1)}
                  </div>
                  <h3 className={s.sTitle}>{step.title}</h3>
                  <p className={s.sBody}>{step.body}</p>
                </div>
                {visuals[i]}
              </li>
            ))}
          </ol>
        </div>
        <div className={s.wrap}>
          <div className={s.sProg} aria-hidden>
            <i data-part="progress" />
          </div>
        </div>
      </div>
    </section>
  );
}
