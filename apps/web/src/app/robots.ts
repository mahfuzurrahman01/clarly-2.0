import type { MetadataRoute } from "next";
import { getPublicEnv } from "@/lib/env";

// Disallow everything behind auth (the (app) route group console) plus
// internal API routes and post-auth flows that have nothing to offer a
// crawler. Keep /login, /signup, /forgot-password, /reset-password, and the
// legal/marketing pages crawlable — see sitemap.ts for the indexed set.
const DISALLOW = [
  "/home",
  "/inbox",
  "/tickets",
  "/insights",
  "/playground",
  "/settings",
  "/onboarding",
  "/auth/callback",
  "/api/",
];

export default function robots(): MetadataRoute.Robots {
  const base = getPublicEnv().NEXT_PUBLIC_SITE_URL;

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: DISALLOW,
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
