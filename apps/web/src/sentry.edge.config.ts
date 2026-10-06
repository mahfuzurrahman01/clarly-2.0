// Launch Plan item 7: edge-runtime Sentry init (middleware.ts runs on the
// edge runtime in this app), imported by instrumentation.ts's register()
// when NEXT_RUNTIME === 'edge'. Same no-op-when-unset pattern as the other
// two config files.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}
