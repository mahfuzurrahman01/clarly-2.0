// Launch Plan item 7: server-runtime Sentry init, imported by
// instrumentation.ts's register() when NEXT_RUNTIME === 'nodejs'. Real
// no-op when the DSN is unset — see instrumentation-client.ts's own
// comment for why this reads NEXT_PUBLIC_SENTRY_DSN (a DSN is not a
// secret) rather than a separate server-only var.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // See instrumentation-client.ts: this app's error surface is customer
    // WhatsApp content, so request-data capture is off by default.
    sendDefaultPii: false,
  });
}
