// Launch Plan item 7 (observability): client-side Sentry init — replaces
// the older sentry.client.config.ts convention (Next.js 15+/16). Real no-op
// when NEXT_PUBLIC_SENTRY_DSN is unset, same pattern apps/api's
// instrument.ts uses — Sentry.init() is skipped entirely rather than called
// with an empty DSN.
//
// A Sentry DSN is not a secret (it identifies a project, not an account —
// Sentry's own docs treat it as safe to ship in a client bundle), so
// NEXT_PUBLIC_ prefixing it is the correct/expected pattern, not an
// oversight.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // PII scrubbing (Launch Plan item 7): this console renders WhatsApp
    // conversation content — customer phone numbers, message text, KB
    // passages. Session Replay and the feedback widget are both off by
    // default rather than opt-out: neither is worth the risk of a replay
    // recording a support agent's screen full of that content for the
    // marginal debugging value here.
    sendDefaultPii: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
