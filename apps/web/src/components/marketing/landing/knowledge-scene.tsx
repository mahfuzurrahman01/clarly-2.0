"use client";

import { useRef, type CSSProperties } from "react";
import { Check, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { RichText } from "./phone";
import { gsap, inlineSign, landingMedia, offsetWithin, onceInView, scoped, ScrollTrigger, SCRUB, useGSAP } from "./motion";
import s from "./landing.module.css";

/** Passages each document visibly contributes to the knowledge-base grid. */
const DOTS_PER_DOC = 12;
/** Fly-in origins for the documents: [x, y, rotation]. */
const FROM: [number, number, number][] = [
  [-420, -300, -18],
  [380, -260, 14],
  [-360, 240, 10],
  [300, 320, -12],
  [-80, 420, 20],
];
const REST_ROTATION = [-3, 2, -1.5, 2.5, -1];

/**
 * 01 · Knowledge — documents fly in, get scanned, and shed passages (dots)
 * into the knowledge-base grid while the counters climb.
 */
export function KnowledgeScene({ c }: { c: LandingContent["knowledge"] }) {
  const root = useRef<HTMLElement>(null);
  const cellCount = c.docs.length * DOTS_PER_DOC;
  const totalPassages = c.docs.reduce((sum, d) => sum + d.passages, 0);

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      const mm = landingMedia(el, {
        full: () => {
          const stage = one("[data-part=stage]");
          const docs = all("[data-part=doc]");
          const cells = all("[data-part=cell]");
          const dots = all("[data-part=kdot]");
          const docsEl = one("[data-part=docs-count]");
          const passEl = one("[data-part=pass-count]");
          const counters = { d: 0, p: 0 };
          const render = () => {
            docsEl.textContent = String(Math.round(counters.d));
            passEl.textContent = String(Math.round(counters.p));
          };
          render();
          const dir = inlineSign(el);
          const DOT = 12.8; // .kdot is 0.8rem

          const docOf = (dot: HTMLElement) => docs[Number(dot.dataset.doc)];
          const cellOf = (dot: HTMLElement) => cells[Number(dot.dataset.cell)];
          const fromX = (_: number, dot: HTMLElement) => {
            const o = offsetWithin(docOf(dot), stage);
            return o.x + o.w * (0.25 + Math.random() * 0.5) - DOT / 2;
          };
          const fromY = (_: number, dot: HTMLElement) => {
            const o = offsetWithin(docOf(dot), stage);
            return o.y + o.h * (0.3 + Math.random() * 0.4) - DOT / 2;
          };
          const toX = (_: number, dot: HTMLElement) => {
            const o = offsetWithin(cellOf(dot), stage);
            return o.x + o.w / 2 - DOT / 2;
          };
          const toY = (_: number, dot: HTMLElement) => {
            const o = offsetWithin(cellOf(dot), stage);
            return o.y + o.h / 2 - DOT / 2;
          };

          gsap.set(docs, { rotation: (i) => REST_ROTATION[i % REST_ROTATION.length] });
          gsap.set(all("[data-part=doc-ok]"), { autoAlpha: 0 });
          gsap.set(dots, { autoAlpha: 0 });
          gsap.set(["[data-part=kb-ready]", "[data-part=kb-glow]"], { autoAlpha: 0 });

          const tl = gsap.timeline({ defaults: { ease: "none" } });
          docs.forEach((d, i) => {
            const [x, y, r] = FROM[i % FROM.length];
            tl.from(d, { x: x * dir, y, rotation: r, autoAlpha: 0, duration: 1, ease: "power3.out" }, i * 0.18);
          });
          let running = 0;
          docs.forEach((d, i) => {
            const t0 = 1.6 + i * 1.5;
            running += c.docs[i].passages;
            const mine = dots.slice(i * DOTS_PER_DOC, (i + 1) * DOTS_PER_DOC);
            const scan = d.querySelector("[data-part=doc-scan]");
            tl.to(d, { x: 14 * dir, duration: 0.3, ease: "power2.out" }, t0)
              .fromTo(scan, { scaleY: 0, autoAlpha: 1 }, { scaleY: 1, duration: 0.6, ease: "power1.inOut" }, t0)
              .to(scan, { autoAlpha: 0, duration: 0.25 }, t0 + 0.6)
              .to(d.querySelector("[data-part=doc-ok]"), { autoAlpha: 1, duration: 0.2 }, t0 + 0.6)
              .fromTo(
                mine,
                { autoAlpha: 0, x: fromX, y: fromY, scale: 0.4 },
                { autoAlpha: 1, x: toX, y: toY, scale: 1, duration: 0.9, stagger: 0.035, ease: "power2.inOut" },
                t0 + 0.35,
              )
              .to(counters, { d: i + 1, p: running, duration: 0.9, onUpdate: render }, t0 + 0.35)
              .to(d, { x: 0, duration: 0.3 }, t0 + 1.1);
          });
          tl.to("[data-part=kb-glow]", { autoAlpha: 1, duration: 0.4 }, "+=0.1")
            .fromTo("[data-part=kb-ready]", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, "<")
            .to({}, { duration: 0.9 });

          ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: "+=3200",
            pin: true,
            scrub: SCRUB,
            animation: tl,
            invalidateOnRefresh: true,
          });
        },
        lite: () => {
          all("[data-part=doc], [data-part=kb]").forEach((node) =>
            onceInView(node, () => gsap.from(node, { y: 28, autoAlpha: 0, duration: 0.8, ease: "power3.out" }), "top 90%"),
          );
        },
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} id="knowledge" data-chapter={c.chapter} className={s.scene}>
      <div className={cn(s.wrap, s.pinwrap, s.kGrid)}>
        <div>
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>
            <RichText parts={c.title} />
          </h2>
          <p className={s.lede}>{c.body}</p>
          <div className={s.counters}>
            <div>
              <div className={s.counterN}>
                <span data-part="docs-count">{c.docs.length}</span>
                <small>/{c.docs.length}</small>
              </div>
              <div className={cn("eyebrow", s.counterL)}>{c.docsLabel}</div>
            </div>
            <div>
              <div className={s.counterN} data-part="pass-count">
                {totalPassages}
              </div>
              <div className={cn("eyebrow", s.counterL)}>{c.passagesLabel}</div>
            </div>
          </div>
        </div>

        <div className={s.kStage} data-part="stage">
          <div className={s.docs}>
            {c.docs.map((d, i) => (
              <article key={d.name} className={s.doc} data-part="doc" style={{ "--i": i } as CSSProperties}>
                <div className={s.docTitle}>
                  <FileText className={s.icon} aria-hidden />
                  <span dir="auto">{d.name}</span>
                </div>
                <div className={s.docLines} aria-hidden>
                  <i />
                  <i />
                  <i />
                </div>
                <div className={s.docMeta}>
                  <span className="eyebrow">
                    {d.passages} {c.passagesWord}
                  </span>
                  <span className={cn("eyebrow", s.docOk)} data-part="doc-ok">
                    <Check className={s.icon} aria-hidden />
                    {c.readWord}
                  </span>
                </div>
                <div className={s.docScan} data-part="doc-scan" aria-hidden />
              </article>
            ))}
          </div>

          <div className={s.kb} data-part="kb">
            <div className={s.kbHead}>
              <span>{c.kbTitle}</span>
              <span className="eyebrow">{c.kbOwner}</span>
            </div>
            <div className={s.cells} aria-hidden>
              {Array.from({ length: cellCount }, (_, i) => (
                <span key={i} className={s.cell} data-part="cell" />
              ))}
            </div>
            <div className={s.kbReady} data-part="kb-ready">
              <Check className={s.icon} aria-hidden />
              {c.ready}
            </div>
            <div className={s.kbGlow} data-part="kb-glow" aria-hidden />
          </div>

          {Array.from({ length: cellCount }, (_, i) => (
            <span
              key={i}
              className={s.kdot}
              data-part="kdot"
              data-doc={Math.floor(i / DOTS_PER_DOC)}
              data-cell={i}
              aria-hidden
            />
          ))}
        </div>
      </div>
    </section>
  );
}
