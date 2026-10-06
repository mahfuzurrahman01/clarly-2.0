"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { pad2 } from "./motion";
import s from "./landing.module.css";

export type Chapter = { id: string; label: string };

/**
 * Side rail listing the page's chapters. The active chapter is whichever
 * section — or its pin spacer while pinned — has crossed the middle of the
 * viewport. Measured once per animation frame at most.
 */
export function ChapterRail({ label, chapters }: { label: string; chapters: Chapter[] }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const sections = chapters
      .map((c) => document.getElementById(c.id))
      .filter((el): el is HTMLElement => el !== null);

    let frame = 0;
    const measure = () => {
      frame = 0;
      const mid = window.innerHeight / 2;
      let idx = 0;
      sections.forEach((el, i) => {
        const box = el.parentElement?.classList.contains("pin-spacer") ? el.parentElement : el;
        if (box.getBoundingClientRect().top <= mid) idx = i;
      });
      setActive(idx);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [chapters]);

  return (
    <nav className={s.rail} aria-label={label}>
      {chapters.map((c, i) => (
        <a key={c.id} href={`#${c.id}`} className={s.railBtn} aria-current={i === active ? "true" : undefined}>
          <span className={s.railDot} />
          <span className={cn("eyebrow", s.railLabel)}>
            {pad2(i)} {c.label}
          </span>
        </a>
      ))}
    </nav>
  );
}
