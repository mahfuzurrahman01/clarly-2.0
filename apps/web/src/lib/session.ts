import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTenant } from "@/lib/api/onboarding";
import { ApiError } from "@/lib/api/client";

export type AppRole = "admin" | "agent";

export type ConsoleSession = {
  token: string;
  userId: string;
  email: string;
  role: AppRole | null;
  tenant: { id: string; name: string };
};

/**
 * The one place server components/layouts resolve who's signed in and which
 * workspace they're in. Redirects to /login if there's no session or the token
 * points at a tenant that no longer exists (stale session). The middleware
 * already guards app routes; this also gives pages the data + bearer token.
 */
export async function getConsoleSession(): Promise<ConsoleSession> {
  const supabase = await createClient();

  // getUser() revalidates against the Supabase Auth server, same as the
  // middleware does. getSession() alone trusts the cookie as-is, which can be
  // a beat behind the middleware's own token rotation on this same request —
  // that mismatch is what caused the login/home flicker loop.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const token = session.access_token;
  const role = (user.app_metadata?.app_role as AppRole) ?? null;

  // A user who signed in but never finished onboarding has no tenant_id
  // claim at all. GET /onboarding/tenant sits behind TenantAuthMiddleware,
  // which requires tenant_id to even parse the token — it 401s before the
  // controller's "tenant not found" 404 logic ever runs, so that branch
  // below can't distinguish "no tenant yet" from "bad token" for this case.
  // Check the claim locally (already in hand from getUser()) instead of
  // relying on the API's status code for this specific decision.
  if (!user.app_metadata?.tenant_id) redirect("/onboarding");

  try {
    const tenant = await getTenant(token);
    return {
      token,
      userId: user.id,
      email: user.email ?? "",
      role,
      tenant,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      // 404 = authenticated but no tenant yet (e.g. the email-confirmation
      // signup path never provisioned). Send them to finish setup rather than
      // to /login, which the middleware would bounce straight back to /home —
      // an infinite loop. 401 = the token itself is bad/expired → re-login.
      if (err.status === 404) redirect("/onboarding");
      if (err.status === 401) redirect("/login");
    }
    throw err;
  }
}
