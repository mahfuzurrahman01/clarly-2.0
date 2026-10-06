"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap, ScrollTrigger } from "./motion";
import { MOTION_ATTR, MOTION_QUERIES, READY_FLAG, TONE_ATTR } from "./motion-queries";

/**
 * Page-level motion runtime: Lenis smooth scrolling driven by GSAP's ticker
 * (one RAF loop for both), in-page anchor links, and a ScrollTrigger refresh
 * once every scene has registered (these effects run after the scenes' layout
 * effects), repeated whenever `refreshKey` changes. Smooth scrolling is skipped
 * under prefers-reduced-motion.
 */
export function SmoothScroll({ refreshKey }: { refreshKey?: string }) {
  useEffect(() => {
    const html = document.documentElement;
    const win = window as unknown as Record<string, unknown>;
    let lenis: Lenis | null = null;
    const tick = (time: number) => lenis?.raf(time * 1000);

    if (!window.matchMedia(MOTION_QUERIES.off).matches) {
      lenis = new Lenis({ lerp: 0.09, autoRaf: false, anchors: true });
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
    }

    win[READY_FLAG] = true;

    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis?.destroy();
      delete win[READY_FLAG];
      html.removeAttribute(MOTION_ATTR);
      html.removeAttribute(TONE_ATTR);
    };
  }, []);

  // Re-measure once the scenes have (re)registered — on first load, and after
  // a locale switch remounts them in the other direction.
  useEffect(() => {
    const refresh = () => ScrollTrigger.refresh();
    refresh();
    void document.fonts?.ready.then(refresh);
  }, [refreshKey]);

  return null;
}
