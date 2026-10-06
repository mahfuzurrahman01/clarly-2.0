import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for Client Components. The session lives in cookies (written
 * by the server client + middleware), so this reads the same session the server
 * sees. Uses the public anon/publishable key — safe to ship to the browser.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
