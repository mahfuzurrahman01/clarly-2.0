/**
 * Motion modes for the landing page, shared by the pre-paint boot script
 * (server-rendered, no imports allowed at runtime) and the GSAP scenes.
 *
 * - full: pinned, scroll-scrubbed cinematic scenes (large viewports)
 * - lite: simple reveal-on-scroll (small or short viewports)
 * - off:  prefers-reduced-motion — everything static, in its final state
 *
 * The three queries are mutually exclusive, so exactly one mode is active.
 */
export const MOTION_QUERIES = {
  full: "(min-width: 1024px) and (min-height: 600px) and (prefers-reduced-motion: no-preference)",
  lite: "(prefers-reduced-motion: no-preference) and (max-width: 1023.98px), (prefers-reduced-motion: no-preference) and (max-height: 599.98px)",
  off: "(prefers-reduced-motion: reduce)",
} as const;

export type MotionMode = keyof typeof MOTION_QUERIES;

/** On <html>: which layout the landing CSS should use. Set before first paint. */
export const MOTION_ATTR = "data-landing-motion";
/** On <html>: "night" / "paper" while that surface sits under the marketing header; absent → the page theme. */
export const TONE_ATTR = "data-header-tone";
/** Set by the motion provider once scenes are live; the boot script's safety net checks it. */
export const READY_FLAG = "__clarlyLandingReady";
