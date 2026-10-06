"use client";

import type { ComponentPropsWithoutRef, PointerEvent } from "react";
import { cn } from "@/lib/utils";
import s from "./aura.module.css";

/**
 * A glass panel with a soft lime light that follows the pointer (and lights
 * up while anything inside has focus). `lift` adds a hover rise for cards
 * that are themselves a choice, like pricing plans.
 */
export function Spotlight({
  lift,
  className,
  onPointerMove,
  ...rest
}: { lift?: boolean } & ComponentPropsWithoutRef<"div">) {
  function track(e: PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
    onPointerMove?.(e);
  }

  return <div className={cn(s.glass, s.spot, lift && s.lift, className)} onPointerMove={track} {...rest} />;
}
