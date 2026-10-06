"use client";

import { useEffect, useRef } from "react";
import { MOTION_QUERIES } from "./motion-queries";

/**
 * The night sky: a faint dot grid (the knowledge-base motif) with a few
 * twinkling stars. Canvas, drawn only while on screen; static under
 * reduced motion. `colorVar` names the CSS custom property the dots are drawn
 * in — the night foreground by default, or a theme token (e.g. `--foreground`)
 * on surfaces that follow light/dark; it's re-read when the theme changes.
 */
export function StarField({ className, colorVar = "--night-foreground" }: { className?: string; colorVar?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let color = "white";
    const still = window.matchMedia(MOTION_QUERIES.off).matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let stars: { x: number; y: number; phase: number; speed: number; r: number }[] = [];
    let grid: HTMLCanvasElement | null = null;
    let raf = 0;
    let visible = false;

    function build() {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      if (!w || !h) return;
      color = getComputedStyle(canvas!).getPropertyValue(colorVar).trim() || "white";
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      grid = document.createElement("canvas");
      grid.width = canvas!.width;
      grid.height = canvas!.height;
      const g = grid.getContext("2d")!;
      g.scale(dpr, dpr);
      g.fillStyle = color;
      g.globalAlpha = 0.13;
      stars = [];
      const gap = 26;
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          if (Math.random() < 0.07) {
            stars.push({ x, y, phase: Math.random() * 6.28, speed: 0.6 + Math.random() * 1.6, r: 0.9 + Math.random() * 0.9 });
          } else {
            g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
          }
        }
      }
      draw(performance.now());
    }

    function draw(t: number) {
      if (!grid) return;
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.drawImage(grid, 0, 0);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.fillStyle = color;
      for (const s of stars) {
        ctx!.globalAlpha = still ? 0.6 : 0.25 + 0.7 * (0.5 + 0.5 * Math.sin((t / 1000) * s.speed + s.phase));
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    function loop(t: number) {
      draw(t);
      raf = visible ? requestAnimationFrame(loop) : 0;
    }

    build();
    const resize = new ResizeObserver(build);
    resize.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && !still;
      if (visible && !raf) raf = requestAnimationFrame(loop);
    });
    io.observe(canvas);
    // Theme switches (next-themes toggles a class on <html>) change the token.
    const theme = new MutationObserver(build);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      io.disconnect();
      theme.disconnect();
    };
  }, [colorVar]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
