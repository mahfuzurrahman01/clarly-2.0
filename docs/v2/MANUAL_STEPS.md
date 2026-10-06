# Clarly 2.0 — Manual Steps (owner / ops)

Everything code cannot do on its own. Kept current per stage; S0–S3 + the RLS fix are covered.
Full variable reference with comments: `apps/api/.env.example` and `apps/web/.env.example`.
The API refuses to boot when a required variable is missing.

## 1. Environment variables

### Required to boot the API
| Variable | What / where to get it |
|---|---|
| `DATABASE_URL` | Supabase **Supavisor transaction pooler** URI (port 6543) as a **non-superuser, NOBYPASSRLS** role (`app_user`). Never the `postgres` role: RLS would be bypassed silently. |
| `REDIS_URL` | Long-lived Redis with persistence (Railway Redis / Redis Cloud / ElastiCache). Not per-request-billed Redis (BullMQ polls). |
| `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API |
| `BSP_CREDENTIALS_ENCRYPTION_KEY` | `openssl rand -base64 32`. Encrypts channel tokens, store/courier credentials, Google refresh tokens, and derives the widget visitor-token key. **Back it up; losing it orphans every stored credential.** |
| `WHATSAPP_CONNECT_STATE_SECRET` | `openssl rand -hex 32` (signs OAuth state for WhatsApp, stores, Google Calendar) |
| `LLM_PROVIDER` + its key (`DEEPSEEK_API_KEY` / `GEMINI_API_KEY`) | v1 boot currently needs **both** `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` (CLARLY_AUDIT #8, fixed in S6) |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_API_KEY` | Embeddings for KB/product search |
| `CONSOLE_BASE_URL`, `API_PUBLIC_BASE_URL`, `CORS_ORIGINS` | Public URLs of the console and API; CORS = console origin |

### Channels, billing, email (needed for real traffic)
`META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_SOCIAL_APP_SECRET`, `META_SOCIAL_VERIFY_TOKEN`,
`META_SOCIAL_CHANNELS_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
`EMAIL_FROM_ADDRESS`, `PLATFORM_ALERT_EMAIL`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`.
Stores (only the ones you offer): `SALLA_*`, `ZID_*`, `SHOPIFY_*`, `WOOCOMMERCE_*`.
Rerank / ASR (optional): `COHERE_API_KEY`, `HUGGINGFACE_API_KEY`.

### Added in v2
| Variable | Stage | Notes |
|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` | S2 | Pair, optional. Without them bookings work as **requests** a human confirms. |
| `GOOGLE_CALENDAR_REDIRECT_URI` | S2 | Optional; default `${API_PUBLIC_BASE_URL}/bookings/calendar/callback` — register exactly this in Google Cloud |
| `TRUST_PROXY_HOPS` | S3 | Number of proxies in front of the API (e.g. Cloudflare + Railway = 2). Per-IP widget rate limits are wrong without it. |
| `NEXT_PUBLIC_SITE_URL` (web) | S3 | Console public origin used in the widget embed snippet |

Web (`apps/web`): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`.

## 2. One-off commands after deploy
1. `pnpm --filter api run db:migrate` — applies migrations up to 0074.
2. `pnpm --filter api run routes:backfill` — only if any courier/store connection existed before migration 0073.
3. `pnpm --filter api run platform:grant --user-id <supabase-uid> --email <you> --role owner` — first operator.

## 3. External accounts / approvals (owner)
- **Google Cloud**: OAuth client (Web) with Calendar scope `calendar.events` + `calendar.freebusy`; consent screen verification (weeks). Decision C25: reuse Autologic's verified project or create new.
- **Meta**: Business verification, Tech Provider onboarding, App Review for every permission in one submission, app Live (decision C24: one Meta app = Clarly's).
- **Stripe**: products/prices for the plan catalogue; webhook endpoint `/billing/webhook`.
- **Supabase**: Pro + compute add-on, PITR on, region near GCC; run a restore drill.
- **ZATCA** e-invoicing provider before charging Saudi customers; PDPL review (KSA/UAE).

## 4. Quality gates before pilots
- Eval re-run on the merged build (PRODUCT_GOALS bars), plus a booking-corpus eval for tenants that enable bookings (S2).
- Live channel test: one real message customer → Meta → Clarly → customer (never done in v1).
- Load test 50 → 120 concurrent conversations on staging (SCALING_1K.md Phase A).
