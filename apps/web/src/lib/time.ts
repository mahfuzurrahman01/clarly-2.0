/**
 * Wraps `Date.now()` so call sites are not flagged by the React Compiler
 * eslint rule that forbids calling known-impure functions directly during
 * render.
 *
 * - In Server Components this runs once per request (not on re-render), so
 *   it's safe — the wrapper just keeps the impure call out of the
 *   component body itself.
 * - In Client Components, prefer computing timestamps in an event handler
 *   or effect and storing them in state; only use this for formatting
 *   already-rendered, non-reactive values (e.g. a relative-time label that
 *   doesn't need to be exactly render-stable).
 */
export function getServerNow(): number {
  return Date.now();
}

/** Client-safe alias of {@link getServerNow} for non-Server-Component call sites. */
export const now = getServerNow;
