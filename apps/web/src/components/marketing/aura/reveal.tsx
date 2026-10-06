"use client";

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import s from "./aura.module.css";

/**
 * Fades and lifts its content in the first time it scrolls into view. Without
 * JavaScript the content is simply visible (the hidden state is gated on
 * `@media (scripting: enabled)`); under reduced motion it shows immediately.
 * `index` staggers siblings.
 */
export function Reveal({
  as: Tag = "div",
  index = 0,
  className,
  style,
  children,
}: {
  as?: ElementType;
  index?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.dataset.shown = "";
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.dataset.shown = "";
        io.disconnect();
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={cn(s.reveal, className)} style={{ "--i": index, ...style } as CSSProperties}>
      {children}
    </Tag>
  );
}
