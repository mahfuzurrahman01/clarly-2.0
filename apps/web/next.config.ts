import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { assertValidEnv } from "./src/lib/env";

// Fail fast: validate env vars as soon as Next reads this config, for every
// command (dev/build/start) — before any route compiles. Next.js loads
// .env* files into process.env before this module runs.
assertValidEnv();

const nextConfig: NextConfig = {
  // The repo already has a root CLAUDE.md governing agent behaviour; don't let
  // Next regenerate its own AGENTS.md/CLAUDE.md inside apps/web on every dev run.
  agentRules: false,
};

// Launch Plan item 7: source-map upload + a few build-time instrumentation
// tweaks (withSentryConfig, not Sentry.init() — that's
// instrumentation-client.ts/sentry.server.config.ts/sentry.edge.config.ts).
// Skipped entirely — plain nextConfig exported as-is — when no DSN is
// configured, so a build in an environment with Sentry unset (this repo's
// CI today) never attempts a Sentry CLI/API call. `silent: true` when
// SENTRY_AUTH_TOKEN is unset keeps a configured-DSN-but-no-token build from
// spamming warnings about a source-map upload it can't do; the widget/
// upload itself already no-ops without a token, this just quiets the log.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.SENTRY_AUTH_TOKEN,
      widenClientFileUpload: true,
      disableLogger: true,
    })
  : nextConfig;
