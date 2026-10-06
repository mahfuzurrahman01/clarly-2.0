import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { WAITLIST_ONLY } from "@/lib/launch";

// Route groups the middleware guards. Anything not listed is public.
const PROTECTED_PREFIXES = [
  "/home",
  "/tickets",
  "/inbox",
  "/playground",
  "/insights",
  "/settings",
];
// Note: /reset-password is intentionally absent — a password-recovery link
// authenticates the user, and bouncing them to /home would break the reset.
const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];

function isMatch(pathname: string, prefixes: string[]) {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Refreshes the Supabase session on every request (required for cookie-based
 * auth to stay alive across Server Components) and enforces coarse route access:
 * unauthenticated users can't reach app routes, authenticated users skip the
 * auth pages.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() re-validates the token against Supabase and triggers
  // the cookie refresh above. Do not gate on getSession() here — it trusts the
  // cookie without revalidating.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Waitlist-only launch: signed-out visitors to the console go to the
  // waitlist, so the (hidden) sign-in page is only reached by typing its URL.
  if (WAITLIST_ONLY && !user && isMatch(pathname, PROTECTED_PREFIXES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/waitlist";
    url.search = "";
    return redirectPreservingCookies(url, response);
  }

  if (!user && isMatch(pathname, PROTECTED_PREFIXES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return redirectPreservingCookies(url, response);
  }

  if (user && isMatch(pathname, AUTH_PAGES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/home";
    url.search = "";
    return redirectPreservingCookies(url, response);
  }

  return response;
}

// A redirect must carry the refreshed session cookies, or the very next request
// re-runs the refresh and can bounce the user.
function redirectPreservingCookies(url: URL, from: NextResponse) {
  const redirect = NextResponse.redirect(url);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}
