// Launch Plan item 7 (observability): Sentry on the API/worker process
// (@sentry/nestjs). Imported as the FIRST line of main.ts — before any other
// module — because @sentry/nestjs instruments other modules (HTTP, Nest's
// own request pipeline) at import time; importing it later would miss
// whatever already loaded.
//
// This process serves both HTTP (the API) and every BullMQ @Processor
// (respond-path, media-download, the alerting sweeps, ...) — there is no
// separate worker binary — so one Sentry.init() here covers both, matching
// how AppConfigService/env.schema.ts already treat this as one deployable.
//
// Reads process.env directly rather than through AppConfigService: this file
// must run before Nest's DI container exists (AppConfigService is a Nest
// provider), and `dotenv/config` is loaded by main.ts on the line right
// after this import — before that, `process.env` only has whatever the
// process's real environment set, which is what production would provide
// anyway (`.env` is a local-dev convenience, not a production input).
// dotenv only mutates process.env (no module instrumentation of its own), so
// loading it here — before Sentry.init() reads process.env — is safe despite
// this file needing to be main.ts's very first import overall. Local dev's
// .env is the only place SENTRY_DSN would come from outside a real
// environment variable; production sets real env vars, where this is a
// harmless no-op (dotenv never overrides an already-set variable).
import 'dotenv/config';
import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN;

// A real no-op when unset, not Sentry.init() called with an empty/undefined
// DSN — the SDK technically tolerates the latter, but skipping the call
// entirely is the same "'none' is a real adapter, never a placeholder
// credential" pattern env.schema.ts uses for every other *_PROVIDER.
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
      : 0.1,
    // PII scrubbing (Launch Plan item 7): this platform's error surface is
    // WhatsApp conversation content — customer phone numbers, message text,
    // KB passages. Sentry's default request-data capture (sendDefaultPii)
    // includes request bodies/headers and would routinely put a customer's
    // phone number and message text into Sentry as a side effect of
    // capturing an unrelated exception. Left off; only ip/user-agent-free
    // request metadata Sentry gathers itself (route, method, status) goes
    // through by default. `beforeSend` on top of that as a second layer:
    // strip the two request headers most likely to carry a credential/token
    // (Authorization, and the Meta webhook signature header) from
    // whatever event context Sentry did capture.
    sendDefaultPii: false,
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) {
        delete headers['authorization'];
        delete headers['Authorization'];
        delete headers['x-hub-signature-256'];
        delete headers['cf-access-client-secret'];
        delete headers['CF-Access-Client-Secret'];
      }
      return event;
    },
  });
}
