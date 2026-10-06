// Startup env validation (fail-fast). Every var the web app reads from
// process.env is declared here once, split into:
//
//   - `publicEnv`  — NEXT_PUBLIC_* vars. Inlined into the client bundle at
//     build time, so each one is referenced as a literal
//     `process.env.NEXT_PUBLIC_X` below (Next's compiler only inlines the
//     literal expression, not a destructure off a dynamic object).
//   - `serverEnv`  — server-only vars. Never sent to the browser.
//
// Both are validated once, at process startup, via `assertValidEnv()`
// (wired up from src/instrumentation.ts and next.config.ts) — a missing or
// malformed var crashes startup with a readable message instead of
// surfacing later as `undefined`/`NaN` three components deep (e.g. today's
// `process.env.NEXT_PUBLIC_API_URL!` non-null assertions, which silently
// become the literal string "undefined" in a fetch URL).
import { z } from "zod";

function metaIdSchema(name: string) {
  return z
    .string()
    .regex(/^\d{1,32}$/, `${name} must be a numeric Meta id`)
    .optional();
}

const publicSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string({ message: "NEXT_PUBLIC_API_URL is required" })
    .url("NEXT_PUBLIC_API_URL must be a valid URL (e.g. http://localhost:4000)"),
  NEXT_PUBLIC_SUPABASE_URL: z
    .string({ message: "NEXT_PUBLIC_SUPABASE_URL is required" })
    .url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string({ message: "NEXT_PUBLIC_SUPABASE_ANON_KEY is required" })
    .min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),
  // Gates the cookie-consent banner (see components/shell/cookie-consent-banner.tsx).
  // Off by default — flip this on once analytics/EU-traffic tooling actually
  // sets cookies that need consent; until then the banner would just be
  // asking for permission to do nothing.
  NEXT_PUBLIC_COOKIE_CONSENT_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // Absolute origin used for metadataBase, sitemap.ts, robots.ts, and the
  // OG image's absolute URL (see app/layout.tsx, app/sitemap.ts,
  // app/robots.ts). Defaults to the local dev server — MUST be set to the
  // real production domain once one is live (docs/GULF_PARITY_PLAN.md
  // Phase 4 item 3, production deploy); until then, SEO metadata will point at localhost.
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .url("NEXT_PUBLIC_SITE_URL must be a valid absolute URL")
    .optional()
    .default("http://localhost:3000"),
  // Meta (one app for WhatsApp, Messenger and Instagram). Public by design:
  // FB.init / FB.login run in the browser. Optional so a deployment without
  // a Meta app still boots; the Channels screen then says connecting isn't
  // configured instead of opening a broken popup.
  // Same value as the API's META_APP_ID (FB.init appId).
  NEXT_PUBLIC_FACEBOOK_APP_ID: metaIdSchema("NEXT_PUBLIC_FACEBOOK_APP_ID"),
  // Facebook Login for Business configuration created for WhatsApp Embedded
  // Signup (FB.login config_id; Gulf T3).
  NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID: metaIdSchema(
    "NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID",
  ),
  // Facebook Login for Business configuration (token type: User access
  // token) for connecting Facebook pages + Instagram (FB.login config_id; Gulf T4).
  NEXT_PUBLIC_FACEBOOK_LOGIN_CONFIG_ID: metaIdSchema(
    "NEXT_PUBLIC_FACEBOOK_LOGIN_CONFIG_ID",
  ),
  // Graph API version passed to FB.init. Keep in step with the API's
  // META_GRAPH_VERSION (same default).
  NEXT_PUBLIC_META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "NEXT_PUBLIC_META_GRAPH_VERSION must look like v21.0")
    .optional()
    .default("v21.0"),
  // Web3Forms access key for the landing-page waitlist form. Public by
  // design: Web3Forms' free plan only accepts browser submissions, and the
  // key only lets someone send a form email to the inbox it was issued for.
  // Optional — without it the landing page hides the waitlist section.
  NEXT_PUBLIC_WEB3FORMS_ACCESS_KEY: z
    .string()
    .uuid("NEXT_PUBLIC_WEB3FORMS_ACCESS_KEY must be the UUID Web3Forms emailed you")
    .optional(),
});

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Playground's dev-only webhook simulator (see app/(app)/playground/page.tsx
  // and app/api/dev-simulator/route.ts) — never enabled in production, and
  // when enabled it needs a secret + phone-number-id to sign/target requests.
  DEV_SIMULATOR_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  DEV_SIMULATOR_APP_SECRET: z.string().min(1).optional(),
  DEV_SIMULATOR_PHONE_NUMBER_ID: z.string().min(1).optional(),
});

function readPublicEnv() {
  // Explicit property access (not `process.env` passed wholesale) so
  // Next.js's static NEXT_PUBLIC_* inlining applies to each reference.
  return {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_COOKIE_CONSENT_ENABLED:
      process.env.NEXT_PUBLIC_COOKIE_CONSENT_ENABLED,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_FACEBOOK_APP_ID: emptyToUndefined(
      process.env.NEXT_PUBLIC_FACEBOOK_APP_ID,
    ),
    NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID: emptyToUndefined(
      process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID,
    ),
    NEXT_PUBLIC_FACEBOOK_LOGIN_CONFIG_ID: emptyToUndefined(
      process.env.NEXT_PUBLIC_FACEBOOK_LOGIN_CONFIG_ID,
    ),
    NEXT_PUBLIC_META_GRAPH_VERSION: emptyToUndefined(
      process.env.NEXT_PUBLIC_META_GRAPH_VERSION,
    ),
    NEXT_PUBLIC_WEB3FORMS_ACCESS_KEY: emptyToUndefined(
      process.env.NEXT_PUBLIC_WEB3FORMS_ACCESS_KEY,
    ),
  };
}

/** `FOO=` in an .env file reads as "" — treat it as unset for optional vars. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function formatIssues(title: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return [title, ...lines, "", "Check apps/web/.env.local against apps/web/.env.example."].join("\n");
}

let validated = false;

/**
 * Validates both env groups and throws a single readable error listing
 * every problem found. Call once, as early as possible in the process
 * lifecycle (see src/instrumentation.ts and next.config.ts) — safe to call
 * more than once (a no-op after the first successful run).
 */
export function assertValidEnv(): void {
  if (validated) return;

  const publicResult = publicSchema.safeParse(readPublicEnv());
  const serverResult = serverSchema.safeParse(process.env);

  if (!publicResult.success || !serverResult.success) {
    const messages: string[] = [];
    if (!publicResult.success) {
      messages.push(formatIssues("Invalid public (NEXT_PUBLIC_*) environment variables:", publicResult.error));
    }
    if (!serverResult.success) {
      messages.push(formatIssues("Invalid server environment variables:", serverResult.error));
    }
    throw new Error(`\n\n${messages.join("\n\n")}\n`);
  }

  validated = true;
}

/**
 * Typed, validated public env. Only call after `assertValidEnv()` has run
 * (true for any code that executes after startup) — throws otherwise so a
 * skipped validation step fails loudly rather than handing back
 * unvalidated values.
 */
export function getPublicEnv() {
  assertValidEnv();
  return publicSchema.parse(readPublicEnv());
}

/**
 * What the browser needs for Meta's JS SDK. Null when no app id is set.
 * Each connect flow is available only when its own Login-for-Business
 * configuration id is set too. Plain data, so a Server Component reads it
 * and hands it to the client connect UI as a prop.
 */
export type MetaSdkConfig = {
  appId: string;
  graphVersion: string;
  /** WhatsApp Embedded Signup configuration (Gulf T3). */
  embeddedSignupConfigId: string | null;
  /** Facebook Login for Business configuration for pages + Instagram (Gulf T4). */
  loginConfigId: string | null;
};

export function getMetaSdkConfig(): MetaSdkConfig | null {
  const env = getPublicEnv();
  if (!env.NEXT_PUBLIC_FACEBOOK_APP_ID) return null;
  return {
    appId: env.NEXT_PUBLIC_FACEBOOK_APP_ID,
    graphVersion: env.NEXT_PUBLIC_META_GRAPH_VERSION,
    embeddedSignupConfigId: env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID ?? null,
    loginConfigId: env.NEXT_PUBLIC_FACEBOOK_LOGIN_CONFIG_ID ?? null,
  };
}

/** Web3Forms access key for the landing waitlist form, or null when unset. */
export function getWaitlistAccessKey(): string | null {
  return getPublicEnv().NEXT_PUBLIC_WEB3FORMS_ACCESS_KEY ?? null;
}
