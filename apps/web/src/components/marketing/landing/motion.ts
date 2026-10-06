"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { MOTION_ATTR, MOTION_QUERIES, TONE_ATTR, type MotionMode } from "./motion-queries";

gsap.registerPlugin(ScrollTrigger, useGSAP);

export { gsap, ScrollTrigger, useGSAP };

/** Scrub smoothing (seconds) for every pinned scene, so they all feel the same. */
export const SCRUB = 0.7;

type ModeHandler = () => void | (() => void);

/**
 * Builds a gsap.matchMedia with one branch per motion mode. Each branch first
 * stamps the active mode on <html> (the CSS switches layout on it) and only
 * then runs the scene's handler, so measurements always see the right layout —
 * including after a resize crosses a breakpoint. Call `.revert()` on cleanup.
 */
export function landingMedia(scope: Element, handlers: Partial<Record<MotionMode, ModeHandler>>) {
  // Scoped, so selector strings inside the handlers only match within the scene.
  const mm = gsap.matchMedia(scope);
  (Object.keys(MOTION_QUERIES) as MotionMode[]).forEach((mode) => {
    mm.add(MOTION_QUERIES[mode], () => {
      document.documentElement.setAttribute(MOTION_ATTR, mode);
      return handlers[mode]?.();
    });
  });
  return mm;
}

/**
 * What sits under the marketing header: the night surface, the always-light
 * paper of the hero's dawn, or the page itself (follows the active theme).
 */
export type HeaderTone = "night" | "paper" | "page";

export function setHeaderTone(tone: HeaderTone) {
  const html = document.documentElement;
  if (tone === "page") html.removeAttribute(TONE_ATTR);
  else html.setAttribute(TONE_ATTR, tone);
}

/** Layout position of `el` inside `ancestor`, ignoring transforms. `ancestor` must be positioned. */
export function offsetWithin(el: HTMLElement, ancestor: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/** +1 in LTR, -1 in RTL: multiply a horizontal offset by this to move "forward". */
export function inlineSign(el: Element): 1 | -1 {
  return getComputedStyle(el).direction === "rtl" ? -1 : 1;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Scoped query helpers for a scene root. */
export function scoped(root: HTMLElement) {
  return {
    one: <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!,
    all: <T extends Element = HTMLElement>(sel: string) => Array.from(root.querySelectorAll<T>(sel)),
  };
}

/** Runs `fn` once when `el` scrolls into view. The element keeps its resting state until then. */
export function onceInView(el: Element, fn: () => void, start = "top 82%") {
  return ScrollTrigger.create({ trigger: el, start, once: true, onEnter: fn });
}

/** Counts a number up from `from` in an element's text. */
export function countTo(el: HTMLElement, to: number, opts: { from?: number; duration?: number; delay?: number } = {}) {
  const state = { v: opts.from ?? 0 };
  return gsap.to(state, {
    v: to,
    duration: opts.duration ?? 1.6,
    delay: opts.delay ?? 0,
    ease: "power3.out",
    onUpdate: () => {
      el.textContent = String(Math.round(state.v));
    },
  });
}
