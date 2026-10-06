/**
 * Launch gate. While true, Clarly only takes waitlist signups publicly:
 * - every sign-in / sign-up link and button is hidden (left in the code,
 *   switched off by this flag) and public calls to action point at /waitlist;
 * - signed-out visits to the console go to /waitlist, not /login
 *   (lib/supabase/middleware.ts), so visitors never land on a sign-in page;
 * - the auth pages are marked noindex ((auth)/layout.tsx).
 * The auth pages themselves stay reachable by typing their URL (/login,
 * /signup), so the team can still sign in. Flip to false to reopen
 * self-serve sign-up and sign-in.
 */
export const WAITLIST_ONLY = true;
