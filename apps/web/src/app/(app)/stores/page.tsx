import { redirect } from "next/navigation";

/**
 * Feature 24 (Store Integrations): the OAuth/key-delivery callback's landing
 * page. `StoreCallbackController` and the WooCommerce provider's `return_url`
 * both hardcode `${CONSOLE_BASE_URL}/stores?connected=true&store=<name>` (or
 * `?error=oauth_failed`) server-side — that redirect target is not
 * configurable from here, so this route exists purely to forward onto the
 * actual settings page (which owns the connection list and the toast) with
 * the same query string.
 */
export default async function StoresRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const query = qs.toString();
  redirect(`/settings/store${query ? `?${query}` : ""}`);
}
