"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { ScrollTrigger } from "./motion";
import s from "./landing.module.css";

/** Duration of the .faqA open/close transition — pinned sections re-measure after it. */
const TOGGLE_MS = 450;

/** 09 · FAQ — accordion; the first answer starts open. */
export function FaqSection({ c }: { c: LandingContent["faq"] }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const id = useId();

  function toggle(i: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    // Page height changed; scroll-linked positions below need recomputing.
    window.setTimeout(() => ScrollTrigger.refresh(), TOGGLE_MS);
  }

  return (
    <section id="faq" data-chapter={c.chapter} className={s.sec}>
      <div className={cn(s.wrap, s.faqGrid)}>
        <div>
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>{c.title}</h2>
          <p className={s.lede}>{c.body}</p>
        </div>
        <div className={s.faqList}>
          {c.items.map((item, i) => {
            const expanded = open.has(i);
            return (
              <div key={item.q} className={s.faqItem}>
                <button
                  type="button"
                  className={s.faqQ}
                  aria-expanded={expanded}
                  aria-controls={`${id}-${i}`}
                  onClick={() => toggle(i)}
                >
                  {item.q}
                  <span className={s.faqIcon} aria-hidden>
                    <Plus className={s.icon} />
                  </span>
                </button>
                <div id={`${id}-${i}`} className={s.faqA} role="region" aria-label={item.q}>
                  <div>
                    <p>{item.a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
