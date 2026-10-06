// Next.js instrumentation hook — register() runs once per runtime the app
// boots into (dev, `next start`, and each serverless container in prod).
// - nodejs: fail-fast startup env validation, then Sentry server init.
// - edge: Sentry edge init.
// onRequestError is Sentry's App Router hook for Server Component/proxy/
// route-handler errors that never reach the browser.
// https://nextjs.org/docs/app/guides/instrumentation
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertValidEnv } = await import("@/lib/env");
    assertValidEnv();
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
