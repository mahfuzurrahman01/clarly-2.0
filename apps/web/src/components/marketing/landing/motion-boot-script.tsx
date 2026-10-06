import { MOTION_ATTR, MOTION_QUERIES, READY_FLAG, TONE_ATTR } from "./motion-queries";

/**
 * Runs before first paint (inline, render-blocking, ~300 bytes) so the
 * server-rendered HTML already shows the layout for the visitor's motion mode
 * — no flash of the static layout before hydration. If the motion runtime
 * hasn't started within 6s (script error, blocked JS), it falls back to the
 * static layout so nothing stays hidden.
 */
export function MotionBootScript() {
  const q = JSON.stringify;
  const js =
    `(function(){var d=document.documentElement,m=function(x){return window.matchMedia(x).matches};` +
    `d.setAttribute(${q(MOTION_ATTR)},m(${q(MOTION_QUERIES.off)})?"off":m(${q(MOTION_QUERIES.full)})?"full":"lite");` +
    `d.setAttribute(${q(TONE_ATTR)},"night");` +
    `setTimeout(function(){if(!window[${q(READY_FLAG)}])d.setAttribute(${q(MOTION_ATTR)},"off")},6000)})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
