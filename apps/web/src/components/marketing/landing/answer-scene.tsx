"use client";

import { useRef } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { Bubble, ChatComposer, ChatHeader, Phone, RichText, StatusBar, Typing } from "./phone";
import { gsap, inlineSign, landingMedia, offsetWithin, onceInView, scoped, ScrollTrigger, SCRUB, useGSAP } from "./motion";
import s from "./landing.module.css";

/**
 * 02 · Answers — the patient's question arrives, the reply types itself out,
 * and lines draw from the reply to the exact passages it came from.
 */
export function AnswerScene({ c }: { c: LandingContent["answer"] }) {
  const root = useRef<HTMLElement>(null);
  const used = c.sources.filter((src) => !src.unused);

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      const mm = landingMedia(el, {
        full: () => {
          const grid = one("[data-part=grid]");
          const reply = one("[data-part=reply]");
          const typed = one("[data-part=typed]");
          const full = c.chat.reply;
          const sources = all("[data-part=source-used]");
          const paths = all<SVGPathElement>("[data-part=link]");
          const ends = all<SVGCircleElement>("[data-part=link-end]");
          const dir = inlineSign(el);

          // Connectors run from the reply bubble's outer edge to each source's
          // near edge — whichever side the sources are on (they mirror in RTL).
          const layoutLinks = () => {
            const b = offsetWithin(reply, grid);
            sources.forEach((src, i) => {
              const o = offsetWithin(src, grid);
              const sourcesAfter = o.x > b.x;
              const x1 = sourcesAfter ? b.x + b.w + 6 : b.x - 6;
              const y1 = b.y + b.h * (i ? 0.62 : 0.38);
              const x2 = sourcesAfter ? o.x - 6 : o.x + o.w + 6;
              const y2 = o.y + o.h / 2;
              const mx = (x2 - x1) * 0.55;
              paths[i]?.setAttribute("d", `M ${x1} ${y1} C ${x1 + mx} ${y1}, ${x2 - mx} ${y2}, ${x2} ${y2}`);
              ends[i]?.setAttribute("cx", String(x2));
              ends[i]?.setAttribute("cy", String(y2));
            });
          };
          layoutLinks();
          ScrollTrigger.addEventListener("refresh", layoutLinks);

          const progress = { chars: 0 };
          const renderTyped = () => {
            const n = Math.round(progress.chars);
            typed.textContent = full.slice(0, n);
            typed.classList.toggle(s.caret, n > 0 && n < full.length);
          };
          renderTyped();

          gsap.set(["[data-part=question]", "[data-part=typing]", reply, "[data-part=cite]", "[data-part=meta]"], { autoAlpha: 0 });
          gsap.set(paths, { strokeDasharray: 1, strokeDashoffset: 1 });
          gsap.set(ends, { scale: 0, transformOrigin: "50% 50%" });
          gsap.set(all("[data-part=source-hl]"), { autoAlpha: 0 });
          gsap.set(sources, { opacity: 0.55 });
          gsap.set(all("[data-part=source-unused]"), { opacity: 0.35 });
          gsap.set(all("[data-part=mark]"), { "--mk": "0%" });

          const tl = gsap.timeline({ defaults: { ease: "none" } });
          tl.fromTo(
            "[data-part=question]",
            { autoAlpha: 0, y: 14, scale: 0.96 },
            { autoAlpha: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.6)" },
            0.3,
          )
            .to("[data-part=typing]", { autoAlpha: 1, duration: 0.2 }, 1)
            .to("[data-part=typing]", { autoAlpha: 0, duration: 0.1 }, 1.7)
            .fromTo(reply, { autoAlpha: 0, scale: 0.96 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(1.6)" }, 1.75)
            .to(progress, { chars: full.length, duration: 2.6, onUpdate: renderTyped }, 1.85);
          sources.forEach((src, i) => {
            const t = 2.4 + i * 0.9;
            tl.to(paths[i], { strokeDashoffset: 0, duration: 0.8, ease: "power2.inOut" }, t)
              .to(ends[i], { scale: 1, duration: 0.25, ease: "back.out(3)" }, t + 0.7)
              .to(src, { opacity: 1, x: -6 * dir, duration: 0.4, ease: "power2.out" }, t + 0.7)
              .to(src.querySelector("[data-part=source-hl]"), { autoAlpha: 1, duration: 0.3 }, t + 0.7)
              .to(src.querySelector("[data-part=mark]"), { "--mk": "100%", duration: 0.45, ease: "power2.inOut" }, t + 0.8);
          });
          tl.fromTo("[data-part=cite]", { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 4.5)
            .fromTo("[data-part=meta]", { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 4.8)
            .to({}, { duration: 1 });

          ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: "+=2800",
            pin: true,
            scrub: SCRUB,
            animation: tl,
            invalidateOnRefresh: true,
          });
          return () => ScrollTrigger.removeEventListener("refresh", layoutLinks);
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
    <section ref={root} id="answer" data-chapter={c.chapter} className={s.scene}>
      <div className={cn(s.wrap, s.pinwrap, s.aGrid)} data-part="grid">
        <div data-part="reveal">
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>
            <RichText parts={c.title} />
          </h2>
          <p className={s.lede}>{c.body}</p>
          <ul className={s.factList}>
            {c.timeline.map((f) => (
              <li key={f.text}>
                <span className="eyebrow">{f.time}</span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        <Phone label={c.phoneLabel} data-part="reveal">
          <StatusBar time={c.chat.time} />
          <ChatHeader clinic={c.chat.clinic} status={c.chat.status} initial={c.chat.initial} />
          <div className={s.chatBody}>
            <Bubble kind="in" time={c.chat.time} data-part="question">
              {c.chat.question}
            </Bubble>
            <Typing data-part="typing" />
            <Bubble kind="out" time={c.chat.time} className={s.typedHost} data-part="reply">
              <span className="sr-only">{c.chat.reply}</span>
              <span className={s.ghost} aria-hidden>
                {c.chat.reply}
              </span>
              <span className={s.typed} data-part="typed" aria-hidden />
            </Bubble>
            <div className={cn(s.meta, s.metaEnd)} data-part="cite">
              <FileText className={s.icon} aria-hidden />
              <span className="eyebrow">{c.chat.cite}</span>
            </div>
            <div className={cn(s.meta, s.metaEnd)} data-part="meta">
              <span className={s.chip}>{c.chat.meta}</span>
            </div>
          </div>
          <ChatComposer placeholder={c.chat.placeholder} />
        </Phone>

        <div className={s.srcs}>
          {c.sources.map((src) => (
            <article
              key={src.file}
              className={cn(s.src, src.unused && s.srcUnused)}
              data-part={src.unused ? "source-unused" : "source-used"}
            >
              <div className={cn("eyebrow", s.srcFile)}>
                <FileText className={s.icon} aria-hidden />
                <span dir="auto">{src.file}</span>
              </div>
              <p className={s.srcText} data-part="reveal">
                {src.before}
                {src.mark ? (
                  <mark className={s.mark} data-part="mark">
                    {src.mark}
                  </mark>
                ) : null}
                {src.after}
              </p>
              {src.unused ? null : <div className={s.srcHl} data-part="source-hl" aria-hidden />}
            </article>
          ))}
        </div>

        <svg className={s.links} aria-hidden>
          {used.map((src) => (
            <path key={src.file} data-part="link" pathLength={1} />
          ))}
          {used.map((src) => (
            <circle key={src.file} data-part="link-end" r={4} />
          ))}
        </svg>
      </div>
    </section>
  );
}
