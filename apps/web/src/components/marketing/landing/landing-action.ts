import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { WAITLIST_ONLY } from "@/lib/launch";

/** A call-to-action target shared by the hero, header, pricing cards and closing section. */
export type LandingAction = { href: string; label: string };

/** Id of the closing section that hosts the waitlist form (matches the old `#waitlist` anchor). */
export const WAITLIST_ANCHOR = "waitlist";

/** The waitlist as a call to action, for pages that don't host the form inline. */
export function waitlistAction(t: Dictionary): LandingAction {
  return { href: "/waitlist", label: t.landing.waitlistSubmit };
}

/**
 * Where a public page's primary action goes. During the waitlist-only launch
 * (WAITLIST_ONLY) it's always the waitlist. Otherwise, with a Web3Forms key
 * there is a waitlist form, and without one the CTAs fall back to self-serve
 * signup. `inPage` + a form → the landing page scrolls to its own copy
 * (`#waitlist`); everywhere else links to /waitlist.
 */
export function primaryLandingAction(
  t: Dictionary,
  waitlistEnabled: boolean,
  { inPage = true }: { inPage?: boolean } = {},
): LandingAction {
  if (!WAITLIST_ONLY && !waitlistEnabled) return { href: "/signup", label: t.landing.getStarted };
  return inPage && waitlistEnabled
    ? { href: `#${WAITLIST_ANCHOR}`, label: t.landing.waitlistSubmit }
    : waitlistAction(t);
}
