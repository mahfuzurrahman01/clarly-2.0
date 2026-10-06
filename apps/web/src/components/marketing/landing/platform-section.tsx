"use client";

import { useRef } from "react";
import { ArrowRight, Lock, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InboxStatus, LandingContent } from "@/lib/i18n/landing/types";
import { countTo, gsap, landingMedia, onceInView, scoped, useGSAP } from "./motion";
import s from "./landing.module.css";

const PILL: Record<InboxStatus, string> = {
  answered: s.pillAnswered,
  handedOff: s.pillHandedOff,
  claimed: s.pillClaimed,
};
const THRESHOLD = 0.7;

/** Splits a template on its {{n}} placeholders so they can be styled as variables. */
const templateParts = (template: string) => template.split(/(\{\{\d+\}\})/g).filter(Boolean);

/** 06 · Platform (bento of product surfaces) + the sample numbers band. */
export function PlatformSection({
  c,
  guards,
  numbers,
}: {
  c: LandingContent["platform"];
  guards: string[];
  numbers: LandingContent["numbers"];
}) {
  const root = useRef<HTMLDivElement>(null);
  const maxGap = Math.max(...c.gaps.bars.map((b) => b.value));

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      // Same reveals in both motion layouts; nothing moves under reduced motion.
      const reveal = () => {
        onceInView(one("[data-part=bento]"), () =>
          gsap.from(all("[data-part=box]"), { y: 30, autoAlpha: 0, stagger: 0.08, duration: 0.8, ease: "power3.out" }),
        "top 85%");
        onceInView(one("[data-part=rules]"), () => {
          const knob = one("[data-part=knob]");
          const fill = one("[data-part=fill]");
          const value = one("[data-part=value]");
          const v = { t: 0.5 };
          gsap.to(v, {
            t: THRESHOLD,
            duration: 1.4,
            ease: "power3.inOut",
            onUpdate: () => {
              knob.style.insetInlineStart = `${v.t * 100}%`;
              fill.style.width = `${v.t * 100}%`;
              value.textContent = v.t.toFixed(2);
            },
          });
          gsap.from(all("[data-part=rules] [data-part=chip]"), { autoAlpha: 0, y: 10, stagger: 0.06, duration: 0.5 });
        });
        onceInView(one("[data-part=inbox]"), () =>
          gsap.from(all("[data-part=inbox-row]"), { autoAlpha: 0, y: 12, stagger: 0.1, duration: 0.55 }),
        );
        onceInView(one("[data-part=gaps]"), () =>
          gsap.from(all("[data-part=gap-bar]"), { scaleX: 0, stagger: 0.12, duration: 1, ease: "power3.out" }),
        );
        onceInView(one("[data-part=templates]"), () =>
          gsap.from(all("[data-part=var]"), { scale: 0.5, autoAlpha: 0, stagger: 0.2, duration: 0.5, delay: 0.2, ease: "back.out(2.5)" }),
        );
        onceInView(one("[data-part=audit]"), () =>
          gsap.from(all("[data-part=log-line]"), { autoAlpha: 0, y: 8, stagger: 0.15, duration: 0.45 }),
        );
        onceInView(one("[data-part=hooks]"), () =>
          gsap.from(all("[data-part=flow-node]"), { autoAlpha: 0, scale: 0.9, stagger: 0.08, duration: 0.4 }),
        );
        onceInView(one("[data-part=stats]"), () =>
          all("[data-part=stat]").forEach((stat, i) => countTo(stat, Number(stat.dataset.value), { delay: i * 0.1 })),
        );
      };

      const mm = landingMedia(el, { full: reveal, lite: reveal });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <div ref={root}>
      <section id="platform" data-chapter={c.chapter} className={s.sec}>
        <div className={s.wrap}>
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>{c.title}</h2>
          <p className={s.lede}>{c.body}</p>

          <div className={s.bento} data-part="bento">
            <article className={cn(s.bx, s.bxWide)} data-part="box">
              <div>
                <h3 className={s.bxTitle}>{c.rules.title}</h3>
                <p className={s.bxBody}>{c.rules.body}</p>
              </div>
              <div className={s.viz} data-part="rules">
                <div className={s.chips}>
                  {guards.map((g) => (
                    <span key={g} className={cn(s.chip, s.chipLock)} data-part="chip">
                      <Lock className={s.icon} aria-hidden />
                      {g}
                    </span>
                  ))}
                  <span className={s.chip} data-part="chip">
                    <Plus className={s.icon} aria-hidden />
                    {c.rules.addTopic}
                  </span>
                </div>
                <div className={s.slider}>
                  <div className={s.sliderLabel}>
                    <span className="eyebrow">{c.rules.threshold}</span>
                    <b data-part="value">{THRESHOLD.toFixed(2)}</b>
                  </div>
                  <div className={s.sliderTrack} aria-hidden>
                    <div className={s.sliderFill} data-part="fill" />
                    <div className={s.sliderKnob} data-part="knob" />
                  </div>
                </div>
              </div>
            </article>

            <article className={s.bx} data-part="box">
              <div>
                <h3 className={s.bxTitle}>{c.inbox.title}</h3>
                <p className={s.bxBody}>{c.inbox.body}</p>
              </div>
              <div className={cn(s.viz, s.rows)} data-part="inbox">
                {c.inbox.rows.map((r) => (
                  <div key={r.name} className={s.row} data-part="inbox-row">
                    <span className={cn(s.avatar, s.avatarSm)}>{r.initial}</span>
                    <span className={s.rowPreview}>
                      <b>{r.name}</b>
                      {r.preview}
                    </span>
                    <span className={cn(s.pill, PILL[r.status])}>{c.inbox.status[r.status]}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className={s.bx} data-part="box">
              <div>
                <h3 className={s.bxTitle}>{c.gaps.title}</h3>
                <p className={s.bxBody}>{c.gaps.body}</p>
              </div>
              <div className={cn(s.viz, s.bars)} data-part="gaps">
                {c.gaps.bars.map((b) => (
                  <div key={b.label} className={s.barRow}>
                    <span>{b.label}</span>
                    <span className={s.barTrack}>
                      <i data-part="gap-bar" style={{ width: `${(b.value / maxGap) * 100}%` }} />
                    </span>
                    <span className={s.barVal}>{b.value}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className={cn(s.bx, s.bxWide)} data-part="box">
              <div>
                <h3 className={s.bxTitle}>{c.templates.title}</h3>
                <p className={s.bxBody}>{c.templates.body}</p>
              </div>
              <div className={cn(s.viz, s.tplRow)} data-part="templates">
                <div className={s.tpl}>
                  {templateParts(c.templates.template).map((part, i) =>
                    /^\{\{\d+\}\}$/.test(part) ? (
                      <code key={i} data-part="var">
                        {part}
                      </code>
                    ) : (
                      <span key={i}>{part}</span>
                    ),
                  )}
                </div>
                <span className={cn(s.pill, s.pillAnswered)}>{c.templates.approved}</span>
              </div>
            </article>

            <article className={cn(s.bx, s.bxWide)} data-part="box">
              <div>
                <h3 className={s.bxTitle}>{c.audit.title}</h3>
                <p className={s.bxBody}>{c.audit.body}</p>
              </div>
              <div className={cn(s.viz, s.log)} data-part="audit">
                {c.audit.lines.map((l) => (
                  <div key={l.text} data-part="log-line">
                    <span>{l.time}</span>
                    <span>{l.text}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className={s.bx} data-part="box">
              <div>
                <h3 className={s.bxTitle}>{c.hooks.title}</h3>
                <p className={s.bxBody}>{c.hooks.body}</p>
              </div>
              <div className={cn(s.viz, s.flow)} data-part="hooks">
                {c.hooks.flows.map((f) => (
                  <span key={f.event} className="contents">
                    <span className={cn(s.node, s.nodeCode)} dir="ltr" data-part="flow-node">
                      {f.event}
                    </span>
                    <ArrowRight className={cn(s.icon, "text-muted-foreground rtl:-scale-x-100")} aria-hidden />
                    <span className={s.node} data-part="flow-node">
                      {f.target}
                    </span>
                  </span>
                ))}
              </div>
            </article>
          </div>
        </div>
      </section>

      <section id="numbers" className={s.sec} style={{ paddingTop: 0 }}>
        <div className={s.wrap}>
          <div className={s.secHead}>
            <h2 className={s.h2} style={{ maxWidth: "18ch" }}>
              {numbers.title}
            </h2>
            <span className={cn("eyebrow", s.sampleTag)}>{numbers.sample}</span>
          </div>
          <div className={s.stats} data-part="stats">
            {numbers.stats.map((st) => (
              <div key={st.label} className={s.stat}>
                <div className={s.statN}>
                  <span data-part="stat" data-value={st.value}>
                    {st.value}
                  </span>
                  {st.suffix ? <small>{st.suffix}</small> : null}
                </div>
                <p className={s.statLabel}>{st.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
