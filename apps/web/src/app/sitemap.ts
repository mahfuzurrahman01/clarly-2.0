import type { MetadataRoute } from "next";
import { getPublicEnv } from "@/lib/env";

// Only the public marketing/auth-entry surface — everything behind auth
// ((app) route group: /home, /inbox, /tickets, /playground, /settings/*,
// /insights) is excluded, same list as robots.ts's disallow rules.
const ROUTES = ["/", "/product", "/pricing", "/waitlist", "/legal/terms", "/legal/privacy"];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getPublicEnv().NEXT_PUBLIC_SITE_URL;
  const now = new Date();

  return ROUTES.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.6,
  }));
}
