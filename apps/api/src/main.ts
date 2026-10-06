// Import this first! @sentry/nestjs instruments other modules at import
// time — importing it after anything else would miss whatever already
// loaded. See instrument.ts's own comment for why this reads process.env
// directly rather than waiting for dotenv/AppConfigService.
import './instrument';
// Load apps/api/.env into process.env before anything reads it — AppConfigService
// parses process.env at construction time during Nest DI, which happens inside
// bootstrap() below.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { buildCorsDelegate } from './common/cors';
import { AppConfigService } from './modules/core';
import { Embedder } from './modules/llm/ports/embedder.port';
import { QwenEmbedder } from './modules/llm/qwen-embedder.adapter';

// Several independent modules (the BullMQ schedulers) each hit the same
// unavailable Redis in their own onModuleInit() and reject around the same
// tick. NestFactory.create()'s promise only propagates the first of those
// rejections to bootstrap().catch() below; the rest have no other .catch()
// attached and would otherwise surface as a raw, unattributed
// "UnhandledPromiseRejection" crash instead of the clear fatal-error log
// this file already produces for the first one.
process.on('unhandledRejection', (error: unknown) => {
  console.error('Unhandled rejection during bootstrap:', error);
  process.exit(1);
});

const SWAGGER_DESCRIPTION = `Multi-tenant WhatsApp AI Agent platform API.

**Authenticating from this page:** every operation marked with a padlock needs a
Supabase-issued bearer token. Click **Authorize**, paste the raw JWT (no \`Bearer \`
prefix), and Try-it-out will attach it to every request.

Tokens carry \`tenant_id\` and \`app_role\` claims. Routes tagged admin-only reject
\`app_role: agent\` with a 403 — sign in as an admin persona to exercise them.

**Not listed here:** \`POST /billing/webhook\` is excluded deliberately. Stripe calls it
directly with a signed raw body and no bearer token, so it is not exercisable from this
page.`;

function setupSwagger(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
): void {
  const config = new DocumentBuilder()
    .setTitle('WhatsApp AI Agent API')
    .setDescription(SWAGGER_DESCRIPTION)
    .setVersion('0.0.1')
    .addBearerAuth()
    .build();
  // `cleanupOpenApiDoc` is required by nestjs-zod, not optional polish: it is
  // what post-processes the Zod-derived `createZodDto` models into valid
  // OpenAPI schemas. Without it, request bodies and query params render empty.
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup('docs', app, document, {
    // Keeps the pasted bearer token across page reloads — otherwise every
    // refresh while testing means re-authorizing.
    swaggerOptions: { persistAuthorization: true },
  });
}

async function bootstrap() {
  // rawBody: true — BillingModule's Stripe webhook endpoint needs the
  // exact raw request bytes (via req.rawBody) to verify Stripe's
  // signature; a JSON-parsed-then-reserialized body would not
  // byte-for-byte match what Stripe signed and would always fail
  // verification. Enabling this globally has no effect on any other
  // route — every other controller keeps reading the normal parsed body.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const appConfig = app.get(AppConfigService);

  // SKIP_SWAGGER is an explicit 'true'/'false' string (see env.schema.ts): a
  // bare truthiness check would treat SKIP_SWAGGER=false as "skip it".
  if (!appConfig.isProduction && process.env.SKIP_SWAGGER !== 'true') {
    setupSwagger(app);
  }
  // The web console is served from a different origin than this API in every
  // environment (Vercel vs Railway locally :3000 vs :4000), so cross-origin
  // access is explicit and allow-listed rather than wildcarded.
  // `req.ip` (used by the widget's per-IP limits) must be the visitor's
  // address, not the load balancer's: trust exactly as many proxy hops as
  // the deployment has, never an arbitrary X-Forwarded-For.
  if (appConfig.trustProxyHops > 0) {
    app.set('trust proxy', appConfig.trustProxyHops);
  }
  app.enableCors(buildCorsDelegate(appConfig.corsOrigins));

  await app.listen(appConfig.port);

  // Latency Phase 2 (docs/decisions/latency-investigation.md): prime the
  // embedding host's connection pool so the first customer turn doesn't pay
  // the cold DNS/TLS/Cloudflare-tunnel handshake inside its retrieval budget.
  //
  // Deliberately after listen() and deliberately not awaited: this is one
  // real HTTP round-trip to a remote host, and awaiting it would hold the
  // port closed for up to LLM_REQUEST_TIMEOUT_MS whenever that host is slow
  // or down — turning a latency optimisation into a failed readiness probe.
  // warmUp() swallows its own failures; the pool then warms on first use,
  // which is exactly the pre-Phase-2 behaviour.
  const embedder = app.get(Embedder, { strict: false });
  if (embedder instanceof QwenEmbedder) {
    void embedder.warmUp();
  }
}
bootstrap().catch((error: unknown) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
