// Platform (CoreModule): fail-fast env validation. Every required var is
// validated once at bootstrap (see AppConfigService) — a missing/malformed
// var crashes startup with a readable error instead of surfacing as a
// runtime null-pointer three modules deep.
import { z } from 'zod';
import {
  applyQueueProfileDefaults,
  QUEUE_PROFILES,
} from './queue-profile-defaults';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    // Skips the Swagger/OpenAPI setup in main.ts. Non-production only — the
    // docs route is already off under NODE_ENV=production, so this exists
    // purely to shave boot time when something else is being debugged
    // (building the document walks every controller and every Zod DTO).
    // Read via process.env in main.ts because it is consumed BEFORE
    // AppConfigService is resolved from the Nest container; declared here so
    // it is a documented key rather than an undeclared one, and follows the
    // enum(['true','false']) convention the other booleans use — z.coerce
    // .boolean() would read the STRING "false" as `true`.
    SKIP_SWAGGER: z.enum(['true', 'false']).optional(),

    // Browser clients (apps/web) call this API cross-origin, so the allowed
    // origins have to be explicit — a wildcard would defeat the point once
    // credentialed requests are involved. Comma-separated list; the dev
    // default is the Next.js dev server. Empty string disables CORS entirely.
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    // Clarly 2.0 S3: how many reverse proxies sit in front of the API
    // (Express `trust proxy`), so `req.ip` is the real client for the public
    // widget's per-IP rate limits. 0 (default) trusts none: safe, but every
    // visitor then looks like the proxy. Render alone = 1; Cloudflare in
    // front of Render = 2. Never set it higher than the real hop count, or a
    // client can spoof its IP with X-Forwarded-For.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    // PersistenceModule (T5/D3). Supabase Postgres connection string. In dev/CI
    // this points at the docker-compose Postgres; in prod it is Supabase's
    // Supavisor transaction-mode pooler URI (port 6543) — see
    // docs/decisions/F0-infra.md for the pooling caveat this constrains.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // QueueModule (T6/T9/T11). Local/Docker Redis in dev; Upstash Redis (or the
    // Railway-hosted fallback) in prod — see docs/decisions/F0-infra.md.
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    // QueueModule. 'default' = stock BullMQ worker polling and the normal
    // sweep cadences. 'lean' = for metered / small free Redis tiers: workers
    // idle-poll far less (LeanWorker) and the sub-hourly sweeps default to
    // longer intervals (queue-profile-defaults.ts). Explicit *_INTERVAL_MS
    // vars still win. Unknown values fail startup.
    QUEUE_PROFILE: z.enum(QUEUE_PROFILES).default('default'),

    // AuthModule (T7, Feature 1). Verifies Supabase Auth JWTs (HS256 shared
    // secret — Supabase project settings -> API -> JWT Secret). See
    // docs/decisions/F1-security.md for the claim-mapping contract and the
    // flagged migration path to asymmetric (JWKS/ES256) signing keys.
    SUPABASE_JWT_SECRET: z.string().min(1, 'SUPABASE_JWT_SECRET is required'),

    // WhatsappModule (T6, Feature 2). AES-256-GCM key encrypting
    // whatsapp_numbers.bsp_credentials_encrypted at rest — base64, must
    // decode to exactly 32 bytes. See docs/decisions/F2-channel.md.
    BSP_CREDENTIALS_ENCRYPTION_KEY: z
      .string()
      .min(1, 'BSP_CREDENTIALS_ENCRYPTION_KEY is required')
      .refine(
        (value) => {
          try {
            return Buffer.from(value, 'base64').length === 32;
          } catch {
            return false;
          }
        },
        {
          message:
            'BSP_CREDENTIALS_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes',
        },
      ),

    // WhatsappModule (T0). Which BspAdapter binding is active. 'meta' is
    // the only real provider (Meta Cloud API direct, D14 — 360dialog was
    // removed in Gulf T2, no fallback). 'none' (default) binds a real
    // fail-closed no-op — same pattern as RERANK_PROVIDER/
    // TENANT_PROVISIONING_PROVIDER's 'none', never a placeholder
    // credential — and is refused under NODE_ENV=production (refine below).
    BSP_PROVIDER: z.enum(['none', 'meta']).default('none'),
    // DANGEROUS, DEV-ONLY. Setting this to 'false' makes the WhatsApp
    // adapter accept ANY inbound webhook without verifying its signature —
    // i.e. it makes `POST /webhooks/whatsapp` (and the social webhook) an
    // unauthenticated endpoint that any stranger can inject customer
    // messages into. Since Gulf T3 it no longer waives META_APP_SECRET for
    // BSP_PROVIDER=meta: Embedded Signup's code exchange needs the secret.
    //
    // It originally existed for an unsigned BSP sandbox (removed with
    // 360dialog, D14). Meta always signs, so it is only useful for local
    // replay of captured payloads.
    //
    // A refine() below makes NODE_ENV=production + 'false' a STARTUP
    // FAILURE, so this cannot ship disabled — the guard is structural, not
    // a code-review convention.
    //
    // Parsed as an explicit 'true'/'false' string rather than
    // z.coerce.boolean(), which would coerce the STRING "false" to `true`
    // (non-empty strings are truthy) — the exact bug that would silently
    // leave verification on when someone meant to turn it off, or worse,
    // the reverse in a future inverted flag.
    BSP_WEBHOOK_SIGNATURE_REQUIRED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    // Meta Graph API (BSP_PROVIDER=meta, and the social channels). The
    // single WhatsApp provider since D14; one Meta app fronts WhatsApp,
    // Messenger and Instagram (D8).
    META_GRAPH_BASE_URL: z
      .string()
      .min(1)
      .default('https://graph.facebook.com'),
    META_GRAPH_VERSION: z.string().min(1).default('v21.0'),
    // The Meta APP SECRET — signs every inbound webhook as
    // `X-Hub-Signature-256`. Platform-level (one per Meta app); the
    // per-tenant credential is the access token in whatsapp_numbers, not
    // this.
    META_APP_SECRET: z.string().min(1).optional(),
    // Shared string echoed during Meta's GET subscription handshake. Meta
    // refuses to register a callback URL without it.
    META_VERIFY_TOKEN: z.string().min(1).optional(),

    // ---- Feature 16: Messenger + Instagram DM (MetaChannelModule) ----
    //
    // Separate switch from BSP_PROVIDER on purpose. BSP_PROVIDER picks
    // WhatsApp's binding; the social channels are ADDITIVE, running
    // alongside it (and can be enabled while WhatsApp is still 'none').
    META_SOCIAL_CHANNELS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // The Meta APP ID. `client_id` of the social token refresh
    // (`grant_type=fb_exchange_token`, `/debug_token`) and, since Gulf T3,
    // of the WhatsApp Embedded Signup code exchange. Required when
    // BSP_PROVIDER=meta or META_SOCIAL_CHANNELS_ENABLED=true (refines below).
    // The web app needs the same id as NEXT_PUBLIC_FACEBOOK_APP_ID for FB.init.
    META_APP_ID: z.string().min(1).optional(),
    // DEPRECATED aliases (D8, Gulf T1) — accepted for one release, then
    // removed. One Meta app now fronts WhatsApp, Messenger and Instagram, so
    // META_APP_SECRET / META_VERIFY_TOKEN above are the single pair for all
    // Meta traffic. Each alias is honoured only when its primary is unset
    // (AppConfigService.metaAppSecret / metaVerifyToken), and MetaGraphModule
    // logs a deprecation warning at startup whenever one is set.
    META_SOCIAL_APP_SECRET: z.string().min(1).optional(),
    META_SOCIAL_VERIFY_TOKEN: z.string().min(1).optional(),
    // How often the token-refresh sweep runs. Daily: Meta's long-lived
    // tokens run ~60 days and TOKEN_REFRESH_WINDOW_MS starts trying a week
    // out, so a transient Graph outage costs retries, never a connection.
    META_TOKEN_REFRESH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60 * 1000),
    // Gulf T5 (D5): how often the WhatsApp number-health reconcile reads
    // quality rating, messaging limit, display-name status and health_status
    // from Meta for every connected number. Daily: webhooks carry the urgent
    // changes; this catches what no webhook reports (quality rating) and
    // anything a missed webhook left stale.
    WHATSAPP_HEALTH_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60 * 1000),

    // Per-call deadline on outbound sends, so a hung BSP can't pin a
    // respond-path worker indefinitely. Mirrors LLM_REQUEST_TIMEOUT_MS.
    BSP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

    // WhatsappModule/connect. Signs the CSRF-safe, tenant-bound `state`
    // value a redirect-based connect flow round-trips (ConnectStateService).
    // Not used by Gulf T3's Embedded Signup, a bearer-authenticated POST
    // whose ids are verified against the exchanged token, so it is not
    // required at boot. Deliberately a SEPARATE secret from
    // SUPABASE_JWT_SECRET — that one verifies tokens Supabase issued; this
    // one signs tokens this app issues to itself for a single round-trip,
    // and rotating one must never silently invalidate the other.
    WHATSAPP_CONNECT_STATE_SECRET: z.string().min(1).optional(),
    // This API's own publicly reachable base URL, for URLs we hand to a
    // third party that must point back at us (e.g. the Meta data-deletion
    // status URL, privacy/).
    //
    // Optional, but unset now DISABLES rather than degrades: F20's product
    // image upload 503s (it persists an absolute image_url) and the
    // WooCommerce connect flow 503s unless WOOCOMMERCE_CALLBACK_URL is set
    // explicitly (AppConfigService.isStoreProviderConfigured). Both used to
    // fall back to a bare relative string that failed silently downstream.
    API_PUBLIC_BASE_URL: z.string().url().optional(),

    // KnowledgeBaseModule (Feature 2.5). Which ObjectStorage binding is
    // active. 'local' (default) is the dev/CI filesystem backing; 'supabase'
    // is the production binding per docs/decisions/tool-stack.md — the
    // swap F2.5-kb-foundation.md documented as "deferred, not blocked."
    // Enum, not a boolean, so a third backing (S3/R2) is an enum value plus a
    // factory branch, never a call-site change.
    KB_STORAGE_PROVIDER: z.enum(['local', 'supabase']).default('local'),
    // Local/CI backing dir. Resolved relative to process.cwd() if not
    // absolute. Only read when KB_STORAGE_PROVIDER=local.
    KB_LOCAL_STORAGE_DIR: z.string().min(1).default('.data/kb-uploads'),
    // Supabase Storage bucket holding KB source documents. MUST be a private
    // bucket — these are tenant documents, and tenant isolation here is the
    // `${tenantId}/` storageKey prefix plus the fact that only the API (using
    // the service-role key) ever reads them. A public bucket would expose
    // every tenant's KB to anyone who can guess a URL.
    KB_STORAGE_BUCKET: z.string().min(1).default('kb-documents'),

    // F13: ceiling on an inbound WhatsApp attachment we will store. Meta's
    // own caps are 16MB for video/audio and 100MB for documents; 25MB keeps
    // the common cases (photos, voice notes, invoices) and refuses the rest
    // with a status a human can act on rather than an unbounded upload.
    INBOUND_MEDIA_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),

    // LlmModule (Feature 3, A0/D1). Which chat adapter is bound — an enum,
    // not a free string, so a typo fails startup instead of silently
    // no-op-ing. Both vendors speak the same OpenAI-compatible protocol, so a
    // vendor is an enum value + a factory branch in LlmModule, never a
    // call-site change. See docs/decisions/F3-agent-core.md.
    //
    // 'deepseek' is the default: DeepSeek's OpenAI-compatible API, authenticated
    // with DEEPSEEK_API_KEY. 'qwen' is any vLLM-hosted chat model (self-hosted,
    // no quota). 'gemini' stays selectable as a rollback path.
    LLM_PROVIDER: z.enum(['deepseek', 'qwen', 'gemini']).default('deepseek'),
    // The chat-completions + function-calling endpoint (D1) — the adapter
    // talks to it via the `openai` SDK pointed at this base URL, not a
    // bespoke HTTP client. With LLM_PROVIDER=deepseek this is DeepSeek's
    // OpenAI-compatible surface; with 'qwen' it is the vLLM box's `/v1`;
    // with 'gemini' it is Google's OpenAI-compatible surface.
    LLM_BASE_URL: z.string().min(1).default('https://api.deepseek.com/v1'),
    LLM_MODEL: z.string().min(1).default('deepseek-v4-flash'),
    // A0: per-call deadline before GeminiProvider throws LLMTimeout (feeds
    // the D2 breaker via RESCUE_POLICY). Independent of A4's global loop
    // deadline, which bounds the whole agent turn, not one provider call.
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    // D2: consecutive breaker-counted failures (RESCUE_POLICY's
    // countsTowardBreaker) before the breaker opens and the respond path
    // skips the LLM entirely.
    LLM_BREAKER_FAILURE_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    // D2: how long the breaker stays open before allowing one trial call
    // through (half-open) to test recovery.
    LLM_BREAKER_RESET_MS: z.coerce.number().int().positive().default(30000),

    // A11/A12 (Feature 17): image and voice understanding. Separate vendor
    // selection from LLM_PROVIDER on purpose — the default chat binding is a
    // self-hosted text-only vLLM model, so vision and ASR cannot ride on it.
    // Gemini's multimodal endpoint serves both, authenticated with the same
    // GEMINI_API_KEY.
    //
    // 'none' is a real, supported configuration, not a broken one: it returns
    // the pre-Feature-17 behaviour for that modality — the customer's image or
    // voice note escalates as UNSUPPORTED_MEDIA instead of being answered.
    // Nothing is ever silently dropped in either setting.
    VISION_PROVIDER: z
      .enum(['deepseek', 'gemini', 'qwen', 'none'])
      .default('deepseek'),
    VISION_BASE_URL: z
      .string()
      .min(1)
      .default('https://generativelanguage.googleapis.com/v1beta/openai'),
    VISION_MODEL: z.string().min(1).default('gemini-3.5-flash'),
    ASR_PROVIDER: z
      .enum(['gemini', 'huggingface', 'openai-compatible', 'none'])
      .default('gemini'),
    ASR_BASE_URL: z
      .string()
      .min(1)
      .default('https://generativelanguage.googleapis.com/v1beta/openai'),
    ASR_MODEL: z.string().min(1).default('gemini-3.5-flash'),
    // ASR_PROVIDER=openai-compatible only; empty = keyless server, no Authorization header.
    ASR_API_KEY: z.string().default(''),
    HUGGINGFACE_API_KEY: z.string().default(''),
    HUGGINGFACE_ASR_MODEL: z.string().min(1).default('openai/whisper-large-v3'),
    // Ceiling on the bytes handed to a multimodal model in one turn, distinct
    // from INBOUND_MEDIA_MAX_BYTES (what we are willing to STORE for a human
    // to look at). A 25MB voice note is worth keeping on the ticket and is not
    // worth base64-ing into a prompt — over this, the turn escalates as
    // UNSUPPORTED_MEDIA rather than blowing the loop's deadline.
    MEDIA_UNDERSTANDING_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024),

    // D9 (Launch Plan item 5): the self-hosted vLLM box (LLM_PROVIDER=qwen
    // and/or EMBEDDING_PROVIDER=qwen) sits behind a Cloudflare Access
    // application, not on the open internet — Cloudflare Access's service
    // token model, not a vendor API key. Both headers are sent together on
    // every request to LLM_BASE_URL/EMBEDDING_BASE_URL (see
    // openai-compatible-llm.provider.ts / qwen-embedder.adapter.ts); a
    // missing/wrong/expired token gets a 401/403 from the Cloudflare edge
    // itself, mapped to AiHostAuthFailed (packages/errors), which counts
    // toward D2's circuit breaker so the failure pages instead of retrying
    // into a wall silently. Optional here (dev/CI may run the vLLM box on an
    // open LAN with no Access application in front of it) — the refine()
    // below makes both required in production whenever a self-hosted host is
    // actually selected.
    CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
    CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),

    // Embedder port (Feature 3, A0/D5). Gemini is the only embedding vendor,
    // and since the LLM provider now also runs on Gemini, GEMINI_API_KEY is a
    // single shared credential — one quota serves both chat and per-chunk
    // embedding, so a KB ingest burst and live chat traffic compete for the
    // same rate limit (see docs/HANDOFF.md). DeepSeek was never an option
    // here: it serves no embeddings endpoint at all (/v1/embeddings 404s for
    // every model name).
    GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

    // DeepSeek LLM credentials.
    DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY is required'),
    DEEPSEEK_BASE_URL: z.string().min(1).default('https://api.deepseek.com/v1'),
    DEEPSEEK_MODEL: z.string().min(1).default('deepseek-v4-flash'),

    // 'qwen' is any vLLM-hosted embedding model reachable over the
    // OpenAI-compatible /v1/embeddings surface — self-hosted, so it has no
    // per-minute quota to share with chat traffic, which is why it is the
    // default. 'gemini' stays selectable as a rollback path.
    EMBEDDING_PROVIDER: z.enum(['gemini', 'qwen']).default('qwen'),
    // PINNED to the concrete served id, never the floating `qwen-embed` alias
    // (P0.3 item 1, docs/decisions/A0-production-readiness-plan.md). That alias
    // is the exact mechanism by which the shared host went Qwen3-Embedding-4B
    // (2560-dim) -> 0.6B (1024-dim) inside an hour: both revisions answered to
    // `qwen-embed`, so nothing in config changed while the vector space did.
    // A concrete id turns the same swap into a 404 at the adapter instead.
    EMBEDDING_MODEL: z.string().min(1).default('qwen3-embedding-0.6b'),
    // 1024 is Qwen3-Embedding-0.6B's native width. kb_chunks.embedding is
    // vector(1024), so this is NOT freely tunable — see the refine() below
    // and migration 0023. Gemini can match it via outputDimensionality,
    // which is what keeps the rollback path a config flip plus a re-embed
    // rather than another migration.
    //
    // NOTE: this endpoint is not ours and its served model is not pinned —
    // it changed from Qwen3-Embedding-4B (2560) to 0.6B (1024) mid-
    // development. The adapter's width check turns that into a loud failure
    // instead of a silently corrupted index, but a swap still means a new
    // migration plus a full re-embed. Verify GET <base>/v1/models before
    // changing this.
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
    // Only used when EMBEDDING_PROVIDER=qwen. Optional: the original vLLM
    // box served an unauthenticated endpoint, so there was no key to
    // validate — but 'qwen' now also covers any other OpenAI-compatible
    // self-hosted embedding host (e.g. an EMBEDDING_BASE_URL that isn't the
    // vLLM box at all), and those commonly require a bearer API key. See
    // EMBEDDING_API_KEY below.
    EMBEDDING_BASE_URL: z.string().url().optional(),
    // Bearer token for EMBEDDING_BASE_URL when that host isn't the
    // Cloudflare-Access-fronted vLLM box (CF_ACCESS_CLIENT_ID/SECRET cover
    // that case instead — see qwen-embedder.adapter.ts, which sends both
    // sets of headers whenever they're configured, since a given host uses
    // at most one of the two schemes). Optional because the default vLLM
    // box needs neither.
    EMBEDDING_API_KEY: z.string().min(1).optional(),
    // The served model's max_model_len. Sent as `truncate_prompt_tokens` so
    // an over-long chunk clips instead of failing the batch with a 400.
    EMBEDDING_MAX_INPUT_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(4096),

    // RetrievalModule (Feature 3, A1/D4). Reranking is optional (RRF fusion
    // alone already produces a usable ranking) — 'none' (default, this
    // environment's setting — no Cohere account provisioned) binds a real
    // no-op adapter, never a placeholder credential. COHERE_API_KEY is only
    // validated as required when RERANK_PROVIDER is actually 'cohere'.
    RERANK_PROVIDER: z.enum(['none', 'cohere']).default('none'),
    COHERE_API_KEY: z.string().min(1).optional(),
    // Cycle 3b (2026-09-30): Cohere's rerank call is ~0.4s at p50 but stalls
    // for ~10.5s on 1-3 turns per eval corpus (95th percentile of 1,420
    // calls), which alone put retrieval p95 at 11s. Past this many ms the call
    // is aborted and the query is served in its RRF-fused order — the ranking a
    // rerank-disabled tenant always gets — and the degradation is logged.
    RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

    // AgentModule (Feature 3, A4/D6). The bounded loop's OWN global
    // deadline — separate from LLM_REQUEST_TIMEOUT_MS (one provider call)
    // and from T9's <5s whole-respond-path budget (which also includes
    // retrieval, run before the loop starts). Exceeding this escalates
    // LLM_ERROR (error_forced) rather than let the loop run unbounded.
    AGENT_LOOP_DEADLINE_MS: z.coerce.number().int().positive().default(8000),

    // A6/D12 (2026-08-17): the output-side grounding check
    // (AnswerGroundingVerifierService) — one extra, small LLM call per
    // answered turn that cites at least one passage, verifying the cited
    // passages actually cover the question before the answer leaves. Default
    // ON: it exists to close the two missed-escalation cases that survived
    // every prompt attempt (docs/decisions/A0-production-readiness-plan.md
    // P0.4), and a missed escalation is the failure mode with money and
    // safety attached. Off is the escape hatch for a latency or cost
    // emergency, not the normal state — turning it off restores the measured
    // missed escalations, so say so in the change that does it.
    //
    // Explicit 'true'/'false' string for the same reason as
    // BSP_WEBHOOK_SIGNATURE_REQUIRED above: z.coerce.boolean() reads the
    // string "false" as true.
    AGENT_GROUNDING_CHECK_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    // ConversationModule (Feature 3, T10/D8). Debounce window coalescing
    // consecutive inbound messages from the same customer into one turn —
    // "two distinct messages 1.5s apart" is D8's own example, hence the
    // ~1.5s default.
    BURST_COALESCE_DEBOUNCE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1500),

    // AlertingModule (Feature 5, T4). How often the stuck-ticket sweep
    // (BullMQ repeatable job) runs across every tenant — independent of
    // `tenant_policy.stuck_ticket_threshold_minutes`, which is "how long
    // unclaimed before it counts as stuck," not "how often to check."
    // Default 1 minute: frequent enough that a ticket crossing its
    // tenant's threshold is caught promptly without hammering Postgres
    // with a cross-tenant scan.
    STUCK_TICKET_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60000),

    // AlertingModule (Feature 7, T9). "Instrument and enforce p95 <5s on
    // the agent respond path." Budget is deliberately the whole
    // respond-path SLA (LLM + retrieval + tool calls), not the same
    // number as AGENT_LOOP_DEADLINE_MS (the loop's own internal abort
    // threshold, default 8s) — a turn can finish well inside its deadline
    // and still be slow enough to miss this product-level SLA.
    LATENCY_P95_BUDGET_MS: z.coerce.number().int().positive().default(5000),
    // How far back the p95 sample window looks each sweep.
    LATENCY_CHECK_WINDOW_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .default(15),
    // How often the sweep runs — independent of the window size, same
    // "how often to look" vs "how far back to look" split as T4's own
    // interval/threshold pair.
    LATENCY_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60000),

    // OutcomesModule (Feature 7, A9 "conversation close resolver"). A
    // never-escalated conversation quiet this long is treated as
    // resolved-without-escalation and gets a permanent conversation_outcomes
    // row — same 24h heuristic Feature 5's MetricsService used for its
    // live computation (D7's WhatsApp session-window number, not the real
    // session-window enforcement itself, which WhatsappModule/T3 still
    // haven't built).
    AUTO_CLOSE_INACTIVITY_HOURS: z.coerce.number().int().positive().default(24),
    // Closing conversations isn't time-sensitive the way an alert is —
    // a coarser cadence than the alert sweeps is deliberate, not an
    // oversight.
    AUTO_CLOSE_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300000),

    // Launch billing backend (Lane A): trial lifecycle emails. Daily
    // cadence by default — not time-sensitive the way an alert is; a trial ending in 3
    // days does not need to be discovered to the minute.
    TRIAL_EMAIL_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(86_400_000),
    /** How many days before trialEndsAt the "trial ending soon" email fires. */
    TRIAL_ENDING_SOON_DAYS: z.coerce.number().int().positive().default(3),

    // RetentionModule (Feature 7, T16). "90 days for raw conversation
    // transcripts, indefinite for anonymized resolution-rate metrics
    // only" (BACKEND_PLAN.md's Data Model section). Scoped to
    // `conversations` (cascades to `messages` via its own FK) — NOT
    // `tickets`/`agent_runs` (FK'd with onDelete: 'set null', survive by
    // design) or `conversation_outcomes` (T12, no FK at all, always
    // survives). Cutoff is `lastInboundAt`, not `createdAt` — a
    // conversation is "raw transcript" risk based on when it was last
    // actually active, not when the row was first created.
    TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    // Real retention purges run daily, not minute-by-minute — deliberately
    // the coarsest interval of any sweep in this codebase.
    PURGE_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(86400000),
    // Tenant offboarding (T16's remaining slice). How long a closed tenant's
    // data survives before it is erased for good. Access stops the moment the
    // account is closed; this window exists solely so a mistaken close — or a
    // compromised admin session, which is a real threat against exactly that
    // endpoint — can still be undone. 30 days is the common SaaS default and
    // matches BACKEND_PLAN.md's "30-day hard-delete SLA".
    TENANT_PURGE_GRACE_DAYS: z.coerce.number().int().positive().default(30),
    // How long a finished data-export bundle stays downloadable. It is a
    // complete copy of a workspace and therefore the single most sensitive
    // object this system produces, so it does not sit in a bucket
    // indefinitely waiting to be found. A week is long enough for a person to
    // notice the email and act on it.
    DATA_EXPORT_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // BillingModule (Feature 8, T19). Stripe confirmed as the payment
    // provider (docs/decisions/F8-billing.md, 2026-08-13). 'none' (default — no
    // Stripe account configured in this environment) binds a real no-op
    // adapter, same "real adapter, never a placeholder credential"
    // pattern as OnboardingModule's TenantAuthProvisioningPort.
    BILLING_PROVIDER: z.enum(['none', 'stripe']).default('none'),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    // Signs Stripe webhook payloads — required to verify a webhook
    // request actually came from Stripe (Stripe's own recommended
    // practice), never trusted on payload content alone.
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Points the Stripe SDK at a local server instead of api.stripe.com —
    // `stripe-mock`, Stripe's own offline API double, or an HTTP proxy.
    // The SDK documents `{ host, port, protocol }` for exactly this and
    // calls it "intended for tests and proxies"; production traffic must
    // stay HTTPS to the real host, which the refine() below enforces by
    // refusing this variable outside development/test.
    STRIPE_API_BASE_URL: z.string().url().optional(),

    // Feature 24 (Store Integrations): connects the AI agent to merchants'
    // e-commerce stores for live product queries and order creation.
    //
    // Deliberately NOT a single STORE_PROVIDER enum like BSP_PROVIDER /
    // BILLING_PROVIDER: the store provider is per-tenant, not per-deployment
    // (`store_connections.provider`, resolved at runtime by
    // StoreProviderRegistry). One deployment serves a Salla merchant and a
    // Zid merchant at the same time, so there is no deployment-wide value to
    // refine on at boot, and no `.refine()` here can tell whether a given
    // provider is "in use". Instead, credentials are optional per provider
    // and StoreOAuthService refuses to start a connect flow for a provider
    // whose credentials are missing (AppConfigService.isStoreProviderConfigured)
    // — a loud 503 at connect time instead of an authorize URL with an empty
    // client_id that dead-ends at the provider.
    // Clarly 2.0 S2 (BookingModule): Google Calendar OAuth client for a
    // tenant connecting the calendar bookings are written to. Optional as a
    // pair: unset means "Connect Google Calendar" answers 503 and bookings
    // still work as requests a person confirms. The redirect defaults to
    // `${API_PUBLIC_BASE_URL}/bookings/calendar/callback`; set it only when
    // the URI registered in Google Cloud differs. The OAuth state is signed
    // with WHATSAPP_CONNECT_STATE_SECRET, like every other connect flow.
    GOOGLE_CALENDAR_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CALENDAR_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_CALENDAR_REDIRECT_URI: z.string().url().optional(),
    SALLA_CLIENT_ID: z.string().min(1).optional(),
    SALLA_CLIENT_SECRET: z.string().min(1).optional(),
    // Optional: defaults to `${API_PUBLIC_BASE_URL}/store/callback/salla`,
    // the route StoreCallbackController actually serves. Only set these when
    // the value registered in the provider's app console differs.
    SALLA_REDIRECT_URI: z.string().url().optional(),
    ZID_CLIENT_ID: z.string().min(1).optional(),
    ZID_CLIENT_SECRET: z.string().min(1).optional(),
    ZID_REDIRECT_URI: z.string().url().optional(),
    // The Zid App ID from the Partner Dashboard. Zid's webhook API takes it as
    // `original_id` ("the App ID assigned to your integration, OR the MD5
    // hash of the App ID") when subscribing and deleting store webhooks.
    // Optional: without it a Zid connect still succeeds, but no webhooks are
    // subscribed and the failure is logged and surfaced on the callback.
    ZID_APP_ID: z.string().min(1).optional(),
    SHOPIFY_CLIENT_ID: z.string().min(1).optional(),
    SHOPIFY_CLIENT_SECRET: z.string().min(1).optional(),
    // Fallback shop domain for Shopify's per-shop OAuth host. Normally the
    // shop arrives as a request parameter; this is the single-shop dev case.
    SHOPIFY_SHOP_DOMAIN: z.string().min(1).optional(),
    // WooCommerce has NO platform-level client id/secret, because it is not a
    // hosted platform and there is no OAuth server: each merchant's own
    // WordPress site mints a permanent consumer key/secret pair through
    // `/wc-auth/v1/authorize` and POSTs it to our callback. So the only
    // deployment-wide values are the app name the merchant sees on that
    // approval screen and (optionally) an override for the callback URL the
    // site posts to. There is deliberately no WOOCOMMERCE_SITE_URL — the
    // merchant's site is per connection, carried on
    // StoreOAuthCallbackContext.siteUrl, exactly as Shopify's shop domain is.
    WOOCOMMERCE_APP_NAME: z.string().min(1).default('Clarly'),
    // Optional: defaults to `${API_PUBLIC_BASE_URL}/store/callback/woocommerce`.
    // One of the two MUST be set, or the WooCommerce connect flow 503s —
    // there is no usable relative form of a URL a merchant's own WordPress
    // host has to POST to.
    WOOCOMMERCE_CALLBACK_URL: z.string().url().optional(),
    STORE_SYNC_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),

    // F19 (D1/D8): the hard cap SegmentResolver.snapshot() enforces —
    // resolution that would exceed it aborts the whole transaction (422),
    // rather than leaving a partial snapshot behind.
    CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().positive().default(50000),
    // F19 (D3/D8): the send path. All defaulted, so no deployment breaks.
    /** Recipients per BullMQ job — 50k recipients is 1 000 jobs, not 50 000. */
    CAMPAIGN_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    /** Per-number throughput ceiling. Well under Cloud API's default: the goal is never to be the reason a number gets throttled. */
    CAMPAIGN_SEND_RATE_PER_SECOND: z.coerce
      .number()
      .int()
      .positive()
      .default(20),
    /** Percent of the number's 24h tier allowance a campaign may consume — the rest is headroom for the tenant's own console sends and F26 courier updates. */
    CAMPAIGN_TIER_HEADROOM_PCT: z.coerce
      .number()
      .int()
      .positive()
      .max(100)
      .default(90),
    /** How many 24h messaging windows one campaign may span before it is refused at schedule time. Multi-week drip is deliberately out of scope. */
    CAMPAIGN_MAX_WINDOW_SPAN: z.coerce.number().int().positive().default(3),
    /** Fallback default for `campaigns.spend_cap_usd` when the tenant has no `tenant_policy.campaign_default_spend_cap_usd`. */
    CAMPAIGN_DEFAULT_SPEND_CAP_USD: z.coerce.number().positive().default(50),
    /** Last-touch reply attribution window (D5). */
    CAMPAIGN_REPLY_ATTRIBUTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(7),

    // F26 (D5): the shipment poll sweep's base cadence. The PER-STATUS
    // cadence (out_for_delivery 10m, in_transit 30m, label_created 2h) is
    // applied inside the sweep's own SQL — this is only how often the sweep
    // wakes up to look.
    SHIPMENT_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),

    // AlertingModule (Feature 7/8, T18 "Internal Alerting Completeness").
    // Platform-level checks (D2 breaker open, BullMQ queue/DLQ depth,
    // tenant count, DB/Redis reachability) run together on one sweep —
    // they're all fast, cheap, and share the same natural cadence.
    PLATFORM_HEALTH_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60000),
    // T11's own DLQ definition: a queue's own failed set (removeOnFail:
    // false everywhere in this codebase) IS the de facto DLQ — this is
    // "how many failed jobs before it's worth paging someone."
    QUEUE_DLQ_DEPTH_THRESHOLD: z.coerce.number().int().positive().default(20),
    // D3's pgvector -> Qdrant exit trigger fires at 500 tenants — this is
    // deliberately an EARLY warning at 400, not the trigger itself.
    TENANT_COUNT_ALERT_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(400),
    // T18: per-tenant ToolScopeViolation count within a rolling window —
    // "a live cross-tenant attack probe," so the threshold is
    // deliberately low (even 1 in a short window is worth a look) and the
    // window short, unlike T9's latency-budget window.
    TOOL_SCOPE_VIOLATION_ALERT_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(3),
    TOOL_SCOPE_VIOLATION_CHECK_WINDOW_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    TOOL_SCOPE_VIOLATION_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60000),

    // OnboardingModule (Feature 6). Signup needs to set a fresh Supabase
    // Auth user's app_metadata.tenant_id/app_role (F1-security.md's claim
    // contract) — only a service-role key can write app_metadata, per
    // Supabase's own guidance. 'none' (default — no Supabase project
    // provisioned in this environment) binds a real no-op adapter that
    // logs what it would have done, same pattern as RERANK_PROVIDER's
    // 'none'. Never a placeholder credential.
    TENANT_PROVISIONING_PROVIDER: z.enum(['none', 'supabase']).default('none'),
    SUPABASE_URL: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

    // EmailModule (gap #3). Which EmailSender binding is active. 'none'
    // (default) binds a fail-closed no-op that reports itself disabled and
    // throws if anyone sends through it anyway — the same "real no-op, never
    // a placeholder credential" pattern as BSP_PROVIDER/
    // TENANT_PROVISIONING_PROVIDER.
    //
    // Scope note: this is NOT the channel for password reset, email
    // verification or team invites. Those are Supabase Auth's own flows and
    // go out through the Supabase project's SMTP settings, not through this
    // app. This provider exists for mail the product itself originates —
    // today, critical alerts (an escalated ticket nobody has picked up).
    EMAIL_PROVIDER: z.enum(['none', 'resend']).default('none'),
    RESEND_API_KEY: z.string().min(1).optional(),
    // Must be a verified sender on the Resend domain. Accepts either a bare
    // address or a `Name <address>` display form, which is what Resend's
    // `from` field takes.
    EMAIL_FROM_ADDRESS: z.string().min(1).optional(),
    // Where the console lives, so an alert email can link to the thing it is
    // about. Optional: without it the email still says what happened, it
    // just cannot offer a link.
    CONSOLE_BASE_URL: z.string().url().optional(),

    // ObservabilityModule (Launch Plan item 7). Sentry on the API/worker
    // process (@sentry/nestjs). Optional: unset is a real, supported no-op
    // (instrument.ts skips Sentry.init() entirely) rather than a
    // placeholder DSN — same pattern as every other *_PROVIDER 'none'
    // default in this file, just without an enum since there is only one
    // vendor to swap in.
    SENTRY_DSN: z.string().url().optional(),
    // Defaults to NODE_ENV so events aren't accidentally attributed to the
    // wrong environment when this is left unset.
    SENTRY_ENVIRONMENT: z.string().min(1).optional(),
    // Fraction of transactions traced (0..1). Low default: this is a
    // multi-tenant respond path, and full tracing on every turn is not
    // worth the volume/cost until a specific performance investigation
    // needs it.
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    // Where PlatformHealthAlertEventsService pages a human for a platform-
    // level alert (circuit breaker open, DLQ depth, DB/Redis unreachable) —
    // distinct from AlertEmailService, which mails a TENANT's admins about
    // a tenant-scoped alert. Optional: unset means Sentry (if configured)
    // is the only paging channel, matching AlertEmailService's own
    // "recorded but not emailed" fallback when EMAIL_PROVIDER=none.
    PLATFORM_ALERT_EMAIL: z.string().email().optional(),
  })
  .refine((env) => env.RERANK_PROVIDER !== 'cohere' || !!env.COHERE_API_KEY, {
    message: 'COHERE_API_KEY is required when RERANK_PROVIDER=cohere',
    path: ['COHERE_API_KEY'],
  })
  // LLM_BASE_URL/LLM_MODEL default to DeepSeek's values. When using qwen or
  // gemini, the user must override both to point at the correct host/model.
  .refine(
    (env) =>
      (env.LLM_PROVIDER !== 'qwen' && env.LLM_PROVIDER !== 'gemini') ||
      (!env.LLM_BASE_URL.includes('api.deepseek.com') &&
        !env.LLM_MODEL.startsWith('deepseek')),
    {
      message:
        'LLM_BASE_URL and LLM_MODEL must point at the correct host and model when LLM_PROVIDER=qwen or gemini (they default to DeepSeek values)',
      path: ['LLM_BASE_URL'],
    },
  )
  .refine(
    (env) => env.EMBEDDING_PROVIDER !== 'qwen' || !!env.EMBEDDING_BASE_URL,
    {
      message: 'EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=qwen',
      path: ['EMBEDDING_BASE_URL'],
    },
  )
  // kb_chunks.embedding is vector(1024) (migration 0023). A mismatch here is
  // not a soft misconfiguration: every insert fails on a Postgres dimension
  // error, and retrieval stops working entirely. Fail at boot instead.
  //
  // pgvector also caps HNSW at 2000 dimensions for `vector`, so a model wider
  // than that needs a `halfvec` column (cap 4000), not just a bigger number
  // here.
  .refine((env) => env.EMBEDDING_DIMENSIONS === 1024, {
    message:
      'EMBEDDING_DIMENSIONS must be 1024 to match kb_chunks.embedding vector(1024); changing it requires a new migration and a full re-embed',
    path: ['EMBEDDING_DIMENSIONS'],
  })
  .refine(
    (env) =>
      env.TENANT_PROVISIONING_PROVIDER !== 'supabase' ||
      (!!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY),
    {
      message:
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when TENANT_PROVISIONING_PROVIDER=supabase',
      path: ['SUPABASE_SERVICE_ROLE_KEY'],
    },
  )
  .refine(
    (env) =>
      env.EMAIL_PROVIDER !== 'resend' ||
      (!!env.RESEND_API_KEY && !!env.EMAIL_FROM_ADDRESS),
    {
      message:
        'RESEND_API_KEY and EMAIL_FROM_ADDRESS are required when EMAIL_PROVIDER=resend',
      path: ['RESEND_API_KEY'],
    },
  )
  .refine(
    // Feature 16: the social webhook endpoint has exactly the same
    // "unauthenticated endpoint must be impossible to deploy" requirement as
    // the WhatsApp one. The signature secret and the verify token may come
    // from META_APP_SECRET / META_VERIFY_TOKEN or (deprecated, D8) their
    // META_SOCIAL_* aliases, but one of each must exist before the endpoint
    // can serve.
    (env) =>
      !env.META_SOCIAL_CHANNELS_ENABLED ||
      !env.BSP_WEBHOOK_SIGNATURE_REQUIRED ||
      hasMetaAppSecret(env),
    {
      message:
        'META_APP_SECRET is required when META_SOCIAL_CHANNELS_ENABLED=true — Meta always signs its webhooks, and an unverifiable POST /webhooks/meta would be open to anyone. (The deprecated META_SOCIAL_APP_SECRET alias is still accepted for one release.)',
      path: ['META_APP_SECRET'],
    },
  )
  .refine(
    (env) => !env.META_SOCIAL_CHANNELS_ENABLED || hasMetaVerifyToken(env),
    {
      message:
        'META_VERIFY_TOKEN is required when META_SOCIAL_CHANNELS_ENABLED=true — Meta refuses to register a callback URL without the GET handshake. (The deprecated META_SOCIAL_VERIFY_TOKEN alias is still accepted for one release.)',
      path: ['META_VERIFY_TOKEN'],
    },
  )
  .refine(
    // Without an app id, the token-refresh path cannot run at all — and a
    // Meta channel whose token cannot be refreshed is precisely the silent
    // 60-day failure Feature 16 exists to prevent. Required up front rather
    // than discovered two months later.
    (env) => !env.META_SOCIAL_CHANNELS_ENABLED || !!env.META_APP_ID,
    {
      message:
        'META_APP_ID is required when META_SOCIAL_CHANNELS_ENABLED=true — without it no page/IG access token can ever be refreshed.',
      path: ['META_APP_ID'],
    },
  )
  .refine(
    // The structural half of BSP_WEBHOOK_SIGNATURE_REQUIRED's guard: an
    // unauthenticated webhook endpoint must be impossible to deploy, not
    // merely discouraged. Startup fails loudly instead.
    (env) =>
      env.NODE_ENV !== 'production' || env.BSP_WEBHOOK_SIGNATURE_REQUIRED,
    {
      message:
        'BSP_WEBHOOK_SIGNATURE_REQUIRED=false is a dev/sandbox-only escape hatch and must never be used with NODE_ENV=production — it would leave POST /webhooks/whatsapp open to anyone.',
      path: ['BSP_WEBHOOK_SIGNATURE_REQUIRED'],
    },
  )
  .refine(
    // Without the verify token Meta will never register the webhook, so
    // the adapter would be inbound-dead — fail at startup instead.
    (env) => env.BSP_PROVIDER !== 'meta' || hasMetaVerifyToken(env),
    {
      message: 'META_VERIFY_TOKEN is required when BSP_PROVIDER=meta',
      path: ['META_VERIFY_TOKEN'],
    },
  )
  .refine(
    // Gulf T3: no longer waived by BSP_WEBHOOK_SIGNATURE_REQUIRED=false.
    // Besides signing webhooks, the secret is the `client_secret` of the
    // Embedded Signup code exchange and half of the debug_token app token,
    // so no number can be connected without it.
    (env) => env.BSP_PROVIDER !== 'meta' || hasMetaAppSecret(env),
    {
      message:
        'META_APP_SECRET is required when BSP_PROVIDER=meta (Meta signs its webhooks with it, and Embedded Signup exchanges its code with it)',
      path: ['META_APP_SECRET'],
    },
  )
  .refine(
    // Gulf T3: `client_id` of the Embedded Signup code exchange, and the app
    // a business token must have been issued to (debug_token `app_id`).
    (env) => env.BSP_PROVIDER !== 'meta' || !!env.META_APP_ID,
    {
      message:
        'META_APP_ID is required when BSP_PROVIDER=meta — WhatsApp Embedded Signup exchanges its code with it and checks every business token was issued to it.',
      path: ['META_APP_ID'],
    },
  )
  .refine(
    (env) =>
      env.KB_STORAGE_PROVIDER !== 'supabase' ||
      (!!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY),
    {
      message:
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when KB_STORAGE_PROVIDER=supabase',
      path: ['SUPABASE_SERVICE_ROLE_KEY'],
    },
  )
  .refine(
    (env) =>
      env.BILLING_PROVIDER !== 'stripe' ||
      (!!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET),
    {
      message:
        'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when BILLING_PROVIDER=stripe',
      path: ['STRIPE_SECRET_KEY'],
    },
  )
  // A misplaced STRIPE_API_BASE_URL in production would silently send every
  // real payment call to somewhere that is not Stripe — and, if it is
  // http://, in plaintext with a live secret key attached. Refused at boot
  // rather than trusted to review.
  .refine((env) => !env.STRIPE_API_BASE_URL || env.NODE_ENV !== 'production', {
    message:
      'STRIPE_API_BASE_URL is a local-testing escape hatch (stripe-mock) and must never be set in production.',
    path: ['STRIPE_API_BASE_URL'],
  })
  // D4/Launch Plan item 4: 'none' is a legitimate, real (not placeholder)
  // adapter for every one of these four providers — that's what lets dev/CI
  // run with zero external accounts configured. It is never legitimate in
  // production: a prod deploy with BSP_PROVIDER=none can't receive a single
  // WhatsApp message, BILLING_PROVIDER=none enforces no entitlement at all
  // (T17's usage cap silently never fires), EMAIL_PROVIDER=none means no
  // tenant ever sees a trial-ending/escalated-ticket alert, and
  // TENANT_PROVISIONING_PROVIDER=none means signup can't actually create a
  // usable Supabase Auth user. Each is its own refine (not one combined
  // check) so a startup failure names exactly which provider is still
  // unconfigured, not "something is wrong with production".
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.BSP_PROVIDER !== 'none',
    {
      message:
        'BSP_PROVIDER must not be "none" when NODE_ENV=production — a production deploy with no WhatsApp BSP configured cannot receive any messages.',
      path: ['BSP_PROVIDER'],
    },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.BILLING_PROVIDER !== 'none',
    {
      message:
        'BILLING_PROVIDER must not be "none" when NODE_ENV=production — no entitlement/usage-cap enforcement would run at all (see UsageService.checkEntitlement\'s hasEnforceablePlan gate).',
      path: ['BILLING_PROVIDER'],
    },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.EMAIL_PROVIDER !== 'none',
    {
      message:
        'EMAIL_PROVIDER must not be "none" when NODE_ENV=production — trial-ending/trial-expired and critical-alert emails would silently never send.',
      path: ['EMAIL_PROVIDER'],
    },
  )
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      env.TENANT_PROVISIONING_PROVIDER !== 'none',
    {
      message:
        'TENANT_PROVISIONING_PROVIDER must not be "none" when NODE_ENV=production — signup could not provision a real Supabase Auth user with the tenant_id/app_role claims the rest of the platform relies on.',
      path: ['TENANT_PROVISIONING_PROVIDER'],
    },
  )
  // D9: production must not reach the tunnel unauthenticated. Dev/CI can
  // still run LLM_PROVIDER=qwen/EMBEDDING_PROVIDER=qwen against an
  // open-LAN vLLM box with no Access application in front, but a production
  // deploy pointed at the self-hosted host without both service-token
  // values would send every chat/embedding request straight into a silent
  // 401/403 loop until someone notices replies have stopped.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      (env.LLM_PROVIDER !== 'qwen' && env.EMBEDDING_PROVIDER !== 'qwen') ||
      !!env.CF_ACCESS_CLIENT_ID,
    {
      message:
        'CF_ACCESS_CLIENT_ID is required when NODE_ENV=production and LLM_PROVIDER=qwen or EMBEDDING_PROVIDER=qwen — the self-hosted host sits behind Cloudflare Access.',
      path: ['CF_ACCESS_CLIENT_ID'],
    },
  )
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      (env.LLM_PROVIDER !== 'qwen' && env.EMBEDDING_PROVIDER !== 'qwen') ||
      !!env.CF_ACCESS_CLIENT_SECRET,
    {
      message:
        'CF_ACCESS_CLIENT_SECRET is required when NODE_ENV=production and LLM_PROVIDER=qwen or EMBEDDING_PROVIDER=qwen — the self-hosted host sits behind Cloudflare Access.',
      path: ['CF_ACCESS_CLIENT_SECRET'],
    },
  )
  // Feature 24: a client id without its secret (or vice versa) is always a
  // deployment mistake — the pair is useless half-set, and the half-set half
  // would otherwise sail through boot and fail at the token exchange, long
  // after the merchant has already been redirected to the provider.
  .refine((env) => !!env.SALLA_CLIENT_ID === !!env.SALLA_CLIENT_SECRET, {
    message:
      'SALLA_CLIENT_ID and SALLA_CLIENT_SECRET must be set together — one without the other cannot complete an OAuth token exchange.',
    path: ['SALLA_CLIENT_SECRET'],
  })
  .refine((env) => !!env.ZID_CLIENT_ID === !!env.ZID_CLIENT_SECRET, {
    message:
      'ZID_CLIENT_ID and ZID_CLIENT_SECRET must be set together — one without the other cannot complete an OAuth token exchange.',
    path: ['ZID_CLIENT_SECRET'],
  })
  .refine((env) => !!env.SHOPIFY_CLIENT_ID === !!env.SHOPIFY_CLIENT_SECRET, {
    message:
      'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set together — one without the other cannot complete an OAuth token exchange.',
    path: ['SHOPIFY_CLIENT_SECRET'],
  })
  .refine(
    (env) =>
      !!env.GOOGLE_CALENDAR_CLIENT_ID === !!env.GOOGLE_CALENDAR_CLIENT_SECRET,
    {
      message:
        'GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET must be set together — one without the other cannot complete an OAuth token exchange.',
      path: ['GOOGLE_CALENDAR_CLIENT_SECRET'],
    },
  );

export type Env = z.infer<typeof envSchema>;

/** D8: META_APP_SECRET, or its deprecated META_SOCIAL_APP_SECRET alias, satisfies every "app secret required" rule. */
function hasMetaAppSecret(env: {
  META_APP_SECRET?: string;
  META_SOCIAL_APP_SECRET?: string;
}): boolean {
  return !!(env.META_APP_SECRET ?? env.META_SOCIAL_APP_SECRET);
}

/** D8: same for META_VERIFY_TOKEN and its deprecated META_SOCIAL_VERIFY_TOKEN alias. */
function hasMetaVerifyToken(env: {
  META_VERIFY_TOKEN?: string;
  META_SOCIAL_VERIFY_TOKEN?: string;
}): boolean {
  return !!(env.META_VERIFY_TOKEN ?? env.META_SOCIAL_VERIFY_TOKEN);
}

/**
 * Parses and validates `process.env` against {@link envSchema}. Throws with a
 * readable, aggregated error listing every missing/invalid var — called once
 * at bootstrap (AppConfigService constructor), never per-request.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(applyQueueProfileDefaults(source));
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
